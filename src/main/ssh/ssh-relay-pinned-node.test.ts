import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path, { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_COMPAT_ASSETS } from '../../shared/node-runtime-pin'
import { RELAY_WINDOWS_PROCESS_TREE_FILENAME } from '../../shared/relay-artifacts'
import { remoteInstallVersionDirRegex, RELAY_INSTALL_MODEL } from './remote-install-model'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  pinnedNodeRelayFullVersion,
  pinnedRelayAddonFiles,
  pinnedRelayNodePath,
  planPinnedNodeRelay,
  RELAY_RUNTIME_REF_PREFIX,
  resolveSshRemoteRuntime,
  SSH_REMOTE_RUNTIME_ENV,
  stagePinnedRelayAddons
} from './ssh-relay-pinned-node'
import {
  MUTABLE_PINNED_REFUSAL_REPLAY_MS,
  recordPinnedRuntimeRefusal,
  resetPinnedRuntimeRefusalsForTests
} from './ssh-relay-pinned-refusal-cache'
import { getRemoteHostPlatform } from './ssh-remote-platform'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All connection operations are mocked.
const conn = {} as SshConnection
const SHA = NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256
const directories: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  directories.push(dir)
  return dir
}

function fakeOrcadSlot(target: Parameters<typeof pinnedRelayAddonFiles>[0]): string {
  const dir = tempDir('orcad-slot-')
  for (const file of pinnedRelayAddonFiles(target)) {
    const path = join(dir, ...file.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `bytes of ${file}`)
  }
  return dir
}

beforeEach(() => {
  vi.mocked(execCommand).mockReset()
  resetPinnedRuntimeRefusalsForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('remote runtime setting', () => {
  it('defaults to the pinned ladder, lets the host setting win, and accepts only known env values', () => {
    expect(resolveSshRemoteRuntime(undefined, {})).toBe('pinned-node')
    expect(resolveSshRemoteRuntime({}, {})).toBe('pinned-node')
    expect(resolveSshRemoteRuntime({}, { [SSH_REMOTE_RUNTIME_ENV]: 'legacy' })).toBe('legacy')
    expect(resolveSshRemoteRuntime({}, { [SSH_REMOTE_RUNTIME_ENV]: 'bun' })).toBe('pinned-node')
    expect(
      resolveSshRemoteRuntime(
        { remoteRuntime: 'legacy' },
        { [SSH_REMOTE_RUNTIME_ENV]: 'pinned-node' }
      )
    ).toBe('legacy')
    expect(
      resolveSshRemoteRuntime(
        { remoteRuntime: 'pinned-node' },
        { [SSH_REMOTE_RUNTIME_ENV]: 'legacy' }
      )
    ).toBe('pinned-node')
  })
})

describe('pinned relay version (D8.1)', () => {
  const base = '0.1.0+abcdef012345'

  it('differs from the host-Node build and stays a valid relay version dir', () => {
    const pinned = pinnedNodeRelayFullVersion(base, SHA, 'addons')
    expect(pinned).not.toBe(base)
    expect(pinned).toMatch(/^0\.1\.0\+[0-9a-f]{12}$/)
    expect(remoteInstallVersionDirRegex(RELAY_INSTALL_MODEL).test(`relay-${pinned}`)).toBe(true)
  })

  it('is stable for the same inputs and changes with the runtime or the addons', () => {
    const pinned = pinnedNodeRelayFullVersion(base, SHA, 'addons')
    expect(pinnedNodeRelayFullVersion(base, SHA, 'addons')).toBe(pinned)
    expect(pinnedNodeRelayFullVersion(base, 'f'.repeat(64), 'addons')).not.toBe(pinned)
    expect(pinnedNodeRelayFullVersion(base, SHA, 'other')).not.toBe(pinned)
    expect(pinnedNodeRelayFullVersion('0.1.0+000000000000', SHA, 'addons')).not.toBe(pinned)
  })

  it('refuses a malformed base version rather than inventing a dir name', () => {
    expect(() => pinnedNodeRelayFullVersion('../x', SHA, 'a')).toThrow('semver')
  })
})

describe('staged addons', () => {
  it('copies the slot addons with a runtime ref, and digests their bytes', async () => {
    const slot = fakeOrcadSlot('darwin-arm64')
    const addons = await stagePinnedRelayAddons(slot, 'darwin-arm64', tempDir('stage-'))
    const sha = NODE_RUNTIME_ASSETS['darwin-arm64'].executableSha256
    expect(readFileSync(join(addons.dir, `${RELAY_RUNTIME_REF_PREFIX}${sha}`), 'utf8').trim()).toBe(
      sha
    )
    expect(existsSync(join(addons.dir, 'node_modules/node-pty/build/Release/pty.node'))).toBe(true)
    expect(existsSync(join(addons.dir, 'node_modules/node-pty/build/Release/spawn-helper'))).toBe(
      true
    )
    expect(existsSync(join(addons.dir, 'node_modules/@parcel/watcher/watcher.node'))).toBe(true)

    writeFileSync(join(slot, 'node_modules/node-pty/build/Release/pty.node'), 'rebuilt')
    const changed = await stagePinnedRelayAddons(slot, 'darwin-arm64', tempDir('stage-'))
    expect(changed.digest).not.toBe(addons.digest)
    await addons.dispose()
    expect(existsSync(addons.dir)).toBe(false)
  })

  it('ships the win32 ConPTY pair and the process-table addon at the names the relay loads', async () => {
    const files = pinnedRelayAddonFiles('win32-x64')
    expect(files).toEqual(
      expect.arrayContaining([
        'node_modules/node-pty/build/Release/conpty.node',
        'node_modules/node-pty/build/Release/conpty_console_list.node',
        'node_modules/node-pty/build/Release/conpty/conpty.dll',
        'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
        RELAY_WINDOWS_PROCESS_TREE_FILENAME
      ])
    )
    expect(files).not.toContain('node_modules/node-pty/build/Release/pty.node')
    expect(pinnedRelayAddonFiles('linux-x64-glibc')).not.toContain(
      RELAY_WINDOWS_PROCESS_TREE_FILENAME
    )
    const addons = await stagePinnedRelayAddons(
      fakeOrcadSlot('win32-x64'),
      'win32-x64',
      tempDir('stage-')
    )
    expect(existsSync(join(addons.dir, RELAY_WINDOWS_PROCESS_TREE_FILENAME))).toBe(true)
    await addons.dispose()
  })

  it('refuses a slot missing an addon and leaves nothing behind', async () => {
    const slot = fakeOrcadSlot('linux-x64-glibc')
    rmSync(join(slot, 'node_modules/@parcel/watcher/watcher.node'))
    const parent = tempDir('stage-')
    await expect(stagePinnedRelayAddons(slot, 'linux-x64-glibc', parent)).rejects.toThrow(
      'watcher.node'
    )
    expect(readdirSync(parent)).toEqual([])
  })
})

describe('pinned runtime layout', () => {
  it('launches from the shared runtimes store beside the version dirs', () => {
    const host = getRemoteHostPlatform('linux-x64')
    expect(
      pinnedRelayNodePath(host, '/home/u/.orca-remote/relay-0.1.0+abc', 'linux-x64-glibc')
    ).toBe(`/home/u/.orca-remote/runtimes/node-${SHA}/bin/node`)
  })

  it('keeps node.exe under its real name at the runtime root on Windows', () => {
    const host = getRemoteHostPlatform('win32-x64')
    const sha = NODE_RUNTIME_ASSETS['win32-x64'].executableSha256
    const nodePath = pinnedRelayNodePath(
      host,
      'C:/Users/u/.orca-remote/relay-0.1.0+abc',
      'win32-x64'
    )
    expect(nodePath).toBe(`C:/Users/u/.orca-remote/runtimes/node-${sha}/node.exe`)
    expect(path.win32.normalize(nodePath)).toBe(
      `C:\\Users\\u\\.orca-remote\\runtimes\\node-${sha}\\node.exe`
    )
    expect(path.win32.basename(nodePath)).toBe('node.exe')
  })
})

describe('planPinnedNodeRelay', () => {
  const base = '0.1.0+abcdef012345'

  it('plans a Windows host on the win32 slot without a libc probe', async () => {
    const plan = await planPinnedNodeRelay({
      conn,
      host: getRemoteHostPlatform('win32-arm64'),
      baseVersion: base,
      targetId: 't',
      materializeOrcad: async (target) => fakeOrcadSlot(target)
    })
    expect(execCommand).not.toHaveBeenCalled()
    expect(plan).toMatchObject({ kind: 'pinned-node', target: 'win32-arm64', glibc: null })
    if (plan.kind === 'pinned-node') {
      expect(plan.fullVersion).toBe(
        pinnedNodeRelayFullVersion(
          base,
          NODE_RUNTIME_ASSETS['win32-arm64'].executableSha256,
          plan.addons.digest
        )
      )
      await plan.addons.dispose()
    }
  })

  it('falls back on Windows when this client packaged no win32 slot', async () => {
    await expect(
      planPinnedNodeRelay({
        conn,
        host: getRemoteHostPlatform('win32-x64'),
        baseVersion: base,
        targetId: 't',
        materializeOrcad: () => Promise.reject(new Error('template has no win32-x64'))
      })
    ).rejects.toMatchObject({ reason: 'artifacts_unavailable', remembered: false })
  })

  it('refuses a glibc below the pinned Node floor without uploading anything', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('ldd (GNU libc) 2.17')
    const materializeOrcad = vi.fn()
    await expect(
      planPinnedNodeRelay({
        conn,
        host: getRemoteHostPlatform('linux-x64'),
        baseVersion: base,
        targetId: 't',
        materializeOrcad
      })
    ).rejects.toMatchObject({ reason: 'libc_floor', remembered: false })
    expect(materializeOrcad).not.toHaveBeenCalled()
  })

  it('falls back when the host C library cannot be identified', async () => {
    vi.mocked(execCommand).mockResolvedValue('')
    await expect(
      planPinnedNodeRelay({
        conn,
        host: getRemoteHostPlatform('linux-x64'),
        baseVersion: base,
        targetId: 't'
      })
    ).rejects.toMatchObject({ reason: 'target_unresolved', remembered: false })
  })

  it('does not descend when the libc probe itself is lost', async () => {
    vi.mocked(execCommand).mockRejectedValue(new Error('channel closed'))
    await expect(
      planPinnedNodeRelay({
        conn,
        host: getRemoteHostPlatform('linux-x64'),
        baseVersion: base,
        targetId: 't'
      })
    ).rejects.toThrow('channel closed')
  })

  it('falls back when this client has no orcad slot for the target', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('ldd (GNU libc) 2.31')
    await expect(
      planPinnedNodeRelay({
        conn,
        host: getRemoteHostPlatform('linux-x64'),
        baseVersion: base,
        targetId: 't',
        materializeOrcad: () => Promise.reject(new Error('template missing'))
      })
    ).rejects.toMatchObject({ reason: 'artifacts_unavailable', remembered: false })
  })

  it('remembers a host refusal for the session', async () => {
    recordPinnedRuntimeRefusal('t', 'linux-x64-glibc', 'noexec')
    vi.mocked(execCommand).mockResolvedValue('ldd (GNU libc) 2.31')
    const materializeOrcad = vi.fn()
    await expect(
      planPinnedNodeRelay({
        conn,
        host: getRemoteHostPlatform('linux-x64'),
        baseVersion: base,
        targetId: 't',
        materializeOrcad
      })
    ).rejects.toMatchObject({ reason: 'noexec', remembered: true })
    expect(materializeOrcad).not.toHaveBeenCalled()
  })

  it('re-proves a repaired Windows host once a security-software refusal has aged out', async () => {
    vi.useFakeTimers()
    try {
      recordPinnedRuntimeRefusal('t', 'win32-x64', 'security_software')
      const plan = (): ReturnType<typeof planPinnedNodeRelay> =>
        planPinnedNodeRelay({
          conn,
          host: getRemoteHostPlatform('win32-x64'),
          baseVersion: base,
          targetId: 't',
          materializeOrcad: async (target) => fakeOrcadSlot(target)
        })
      await expect(plan()).rejects.toMatchObject({ remembered: true })
      vi.advanceTimersByTime(MUTABLE_PINNED_REFUSAL_REPLAY_MS)
      await expect(plan()).resolves.toMatchObject({ kind: 'pinned-node', target: 'win32-x64' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps replaying an immutable refusal past the mutable window', async () => {
    vi.useFakeTimers()
    try {
      recordPinnedRuntimeRefusal('t', 'linux-x64-glibc', 'illegal_instruction')
      vi.advanceTimersByTime(MUTABLE_PINNED_REFUSAL_REPLAY_MS * 10)
      vi.mocked(execCommand).mockResolvedValue('ldd (GNU libc) 2.31')
      await expect(
        planPinnedNodeRelay({
          conn,
          host: getRemoteHostPlatform('linux-x64'),
          baseVersion: base,
          targetId: 't',
          materializeOrcad: vi.fn()
        })
      ).rejects.toMatchObject({ reason: 'illegal_instruction', remembered: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('plans a pinned relay with a runtime-folded version for a supported host', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('ldd (GNU libc) 2.28')
    const plan = await planPinnedNodeRelay({
      conn,
      host: getRemoteHostPlatform('linux-x64'),
      baseVersion: base,
      targetId: 't',
      materializeOrcad: async (target) => fakeOrcadSlot(target)
    })
    expect(plan).toMatchObject({
      kind: 'pinned-node',
      target: 'linux-x64-glibc',
      glibc: { major: 2, minor: 28 }
    })
    if (plan.kind === 'pinned-node') {
      expect(plan.fullVersion).toBe(pinnedNodeRelayFullVersion(base, SHA, plan.addons.digest))
      await plan.addons.dispose()
    }
  })

  describe('on the rung B compat runtime', () => {
    const compat = { target: 'linux-x64-glibc217' as const, glibcFloor: { major: 2, minor: 17 } }
    const COMPAT_SHA = NODE_RUNTIME_COMPAT_ASSETS['linux-x64-glibc217'].executableSha256

    it('plans the compat slot on a glibc below the default floor, folding the compat runtime', async () => {
      vi.mocked(execCommand).mockResolvedValueOnce('ldd (GNU libc) 2.17')
      const materializeOrcad = vi.fn(async (target: Parameters<typeof fakeOrcadSlot>[0]) =>
        fakeOrcadSlot(target)
      )
      const plan = await planPinnedNodeRelay({
        conn,
        host: getRemoteHostPlatform('linux-x64'),
        baseVersion: base,
        targetId: 't',
        compat,
        // A persisted rung A refusal says nothing about the compat runtime.
        persistedRefusal: () => 'libc_floor',
        materializeOrcad
      })
      expect(materializeOrcad).toHaveBeenCalledWith('linux-x64-glibc217', undefined)
      expect(plan).toMatchObject({ kind: 'pinned-node', target: 'linux-x64-glibc217' })
      if (plan.kind === 'pinned-node') {
        expect(plan.fullVersion).toBe(
          pinnedNodeRelayFullVersion(base, COMPAT_SHA, plan.addons.digest)
        )
        expect(plan.fullVersion).not.toBe(pinnedNodeRelayFullVersion(base, SHA, plan.addons.digest))
        expect(readdirSync(plan.addons.dir)).toContain(`${RELAY_RUNTIME_REF_PREFIX}${COMPAT_SHA}`)
        await plan.addons.dispose()
      }
    })

    it('refuses a glibc below the compat floor too', async () => {
      vi.mocked(execCommand).mockResolvedValueOnce('ldd (GNU libc) 2.12')
      await expect(
        planPinnedNodeRelay({
          conn,
          host: getRemoteHostPlatform('linux-x64'),
          baseVersion: base,
          targetId: 't',
          compat,
          materializeOrcad: vi.fn()
        })
      ).rejects.toMatchObject({ reason: 'libc_floor', remembered: false })
    })

    it('remembers compat refusals apart from the default runtime', async () => {
      recordPinnedRuntimeRefusal('t', 'linux-x64-glibc', 'libc_floor')
      recordPinnedRuntimeRefusal('t', 'linux-x64-glibc217', 'missing_lib')
      vi.mocked(execCommand).mockResolvedValue('ldd (GNU libc) 2.17')
      await expect(
        planPinnedNodeRelay({
          conn,
          host: getRemoteHostPlatform('linux-x64'),
          baseVersion: base,
          targetId: 't',
          compat,
          materializeOrcad: vi.fn()
        })
      ).rejects.toMatchObject({ reason: 'missing_lib', remembered: true })
    })
  })
})
