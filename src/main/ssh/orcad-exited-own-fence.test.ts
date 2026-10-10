import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { hostname, tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'

// Every remote command runs in a real local shell, so the host-side checks are the real ones.
const shell = vi.hoisted((): { env: NodeJS.ProcessEnv | undefined } => ({ env: undefined }))
vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => {
  const { runProcess } = await import('@orca/process-host')
  const { sshCommandExitError } = await import('./ssh-relay-exec-command')
  return {
    ...(await importOriginal<typeof DeployHelpers>()),
    execCommand: async (_conn: unknown, command: string) => {
      const result = await runProcess({ program: '/bin/sh', args: ['-c', command], env: shell.env })
      if (result.code !== 0) {
        throw sshCommandExitError(command, result.code ?? 1, result.stdout)
      }
      return result.stdout
    }
  }
})

const { orcadActivationFenceRefusal } = await import('./orcad-activation-fence-hold')
const { withOrcadActivationLock } = await import('./orcad-activation-lock')
const { initOrcadHeldFenceTokenFile, ORCAD_HELD_FENCE_TOKENS_FILE_NAME } =
  await import('./orcad-held-fence-tokens')
const { getRemoteHostPlatform } = await import('./ssh-remote-platform')

// Above every Linux and macOS pid_max, so no process can hold it.
const EXITED_PID = 4_194_304 + 1
const homes: string[] = []
afterEach(() => {
  shell.env = undefined
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

function entry(token: string, pid: number, host = hostname()) {
  return { token, pid, host, bootedAt: Date.now() - uptime() * 1000, at: Date.now() }
}

/** A fence quiet for ten minutes, owned by `owner`, with this desktop holding `held`. */
function hostWithFence(owner: string, held: ReturnType<typeof entry>[]) {
  const home = mkdtempSync(join(tmpdir(), 'orcad-exited-fence-'))
  homes.push(home)
  const fence = join(home, '.orca-remote', '.orcad-activation-transaction', '.install-lock')
  mkdirSync(fence, { recursive: true })
  writeFileSync(join(fence, '.orca-fence-owner'), owner)
  const quietSince = new Date(Date.now() - 10 * 60_000)
  utimesSync(fence, quietSince, quietSince)
  mkdirSync(join(home, 'data'))
  initOrcadHeldFenceTokenFile(join(home, 'data', 'orca-data.json'))
  const store = join(home, 'data', ORCAD_HELD_FENCE_TOKENS_FILE_NAME)
  writeFileSync(store, JSON.stringify(held))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked to a local shell, so the connection is never used.
  const options = { conn: {} as never, host: getRemoteHostPlatform('linux-x64'), remoteHome: home }
  return { home, fence, store, options }
}

// BUG-23: a quit mid-update left this desktop's own fence, and the next launch waited 20 minutes.
describe.skipIf(process.platform === 'win32')('a fence this desktop’s exited process left', () => {
  it('is cleared at once when quiet and no state mutation is live', async () => {
    const { fence, store, options } = hostWithFence('t-exited', [entry('t-exited', EXITED_PID)])
    await expect(orcadActivationFenceRefusal(options, 'update')).resolves.toMatchObject({
      cleared: true
    })
    expect(existsSync(fence)).toBe(false)
    expect(readFileSync(store, 'utf-8')).not.toContain('t-exited')
  })

  it('is kept while a state mutation of that run may still be running', async () => {
    const { home, fence, options } = hostWithFence('t-exited', [entry('t-exited', EXITED_PID)])
    // sshd kept the pty-less restore running after the desktop quit.
    const mutation = join(home, '.orca-remote', 'orcad-state-mutation.lock')
    mkdirSync(mutation)
    writeFileSync(join(mutation, 'pid'), String(process.pid))
    const refusal = await orcadActivationFenceRefusal(options, 'update')
    expect(refusal.cleared).toBeUndefined()
    expect(refusal.code).toBe('orcad_activation_fence_busy')
    expect(existsSync(fence)).toBe(true)
  })

  it('is kept while it is not yet quiet', async () => {
    const { fence, options } = hostWithFence('t-exited', [entry('t-exited', EXITED_PID)])
    utimesSync(fence, new Date(), new Date())
    expect((await orcadActivationFenceRefusal(options, 'update')).cleared).toBeUndefined()
    expect(existsSync(fence)).toBe(true)
  })

  it('never touches a fence another desktop holds', async () => {
    const { fence, options } = hostWithFence('t-foreign', [entry('t-ours', EXITED_PID)])
    const refusal = await orcadActivationFenceRefusal(options, 'update')
    expect(refusal.cleared).toBeUndefined()
    expect(refusal.code).toBe('orcad_activation_fence_busy')
    expect(existsSync(fence)).toBe(true)
  })

  it('never touches a fence a live process of this desktop holds', async () => {
    const { fence, options } = hostWithFence('t-live', [entry('t-live', process.pid)])
    expect((await orcadActivationFenceRefusal(options, 'update')).cleared).toBeUndefined()
    expect(existsSync(fence)).toBe(true)
  })

  it('never trusts a pid recorded on another machine sharing the profile', async () => {
    const { fence, options } = hostWithFence('t-exited', [
      entry('t-exited', EXITED_PID, 'another-machine')
    ])
    expect((await orcadActivationFenceRefusal(options, 'update')).cleared).toBeUndefined()
    expect(existsSync(fence)).toBe(true)
  })

  it('hands a fence over a journal to Recover and keeps the journal', async () => {
    const { home, fence, options } = hostWithFence('t-exited', [entry('t-exited', EXITED_PID)])
    const journal = join(home, '.orca-remote', '.orcad-activation-transaction', 'transaction.json')
    writeFileSync(journal, '{"schemaVersion":1}')
    await expect(orcadActivationFenceRefusal(options, 'update')).resolves.toMatchObject({
      code: 'orcad_activation_recovery_required'
    })
    expect(existsSync(journal)).toBe(true)
    expect(existsSync(fence)).toBe(true)
  })

  // Astra 26087: a live successor that replaces the fence after the proof is never aged or taken.
  it('leaves a successor that replaced the fence after the proof alone', async () => {
    const { home, fence, store, options } = hostWithFence('t-exited', [
      entry('t-exited', EXITED_PID)
    ])
    // The successor's takeover lands right after the quiet check proved the exited holder's fence.
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'find'),
      `#!/bin/sh\nPATH='${process.env.PATH}' find "$@"\n` +
        `if [ ! -e '${home}/replaced' ]; then touch '${home}/replaced'; rm -rf '${fence}'; ` +
        `mkdir '${fence}'; printf live-successor > '${fence}/.orca-fence-owner'; fi\n`,
      { mode: 0o755 }
    )
    shell.env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
    const refusal = await orcadActivationFenceRefusal(options, 'update')
    expect(existsSync(join(home, 'replaced'))).toBe(true)
    expect(refusal.cleared).toBeUndefined()
    expect(readFileSync(join(fence, '.orca-fence-owner'), 'utf-8')).toBe('live-successor')
    expect(Date.now() - statSync(fence).mtimeMs).toBeLessThan(60_000)
    expect(readFileSync(store, 'utf-8')).toContain('t-exited')
  })
})

describe.skipIf(process.platform === 'win32')('the held fence token record', () => {
  function held(store: string): string {
    return readFileSync(store, 'utf-8')
  }

  it('holds a token while its run works and drops it on release', async () => {
    const { home, store, options } = hostWithFence('unused', [])
    rmSync(join(home, '.orca-remote'), { recursive: true })
    const during = await withOrcadActivationLock(
      options,
      async () => held(store),
      () => '',
      't-run'
    )
    expect(during).toContain('t-run')
    expect(held(store)).not.toContain('t-run')
  })

  it('drops a token a successor superseded, and keeps one a lost connection left', async () => {
    const { home, fence, store, options } = hostWithFence('unused', [])
    rmSync(join(home, '.orca-remote'), { recursive: true })
    await withOrcadActivationLock(
      options,
      async () => writeFileSync(join(fence, '.orca-fence-owner'), 'successor'),
      () => undefined,
      't-superseded'
    )
    expect(held(store)).not.toContain('t-superseded')
    rmSync(join(home, '.orca-remote'), { recursive: true })

    const lost = Object.assign(new Error('lost'), { sshChannelCloseConfirmed: false })
    await expect(
      withOrcadActivationLock(
        options,
        () => Promise.reject(lost),
        () => undefined,
        't-lost'
      )
    ).rejects.toBe(lost)
    expect(held(store)).toContain('t-lost')
  })

  it('drops a token whose lock was never taken', async () => {
    const { fence, store, options } = hostWithFence('t-foreign', [])
    utimesSync(fence, new Date(), new Date())
    expect(
      await withOrcadActivationLock(
        options,
        async () => 'ran',
        () => 'held',
        't-busy'
      )
    ).toBe('held')
    expect(held(store)).not.toContain('t-busy')
  }, 20_000)

  it('never lets an unwritable record fail a fence operation', async () => {
    const { home, store, options } = hostWithFence('unused', [])
    rmSync(join(home, '.orca-remote'), { recursive: true })
    rmSync(store)
    mkdirSync(store)
    expect(
      await withOrcadActivationLock(
        options,
        async () => 'ran',
        () => 'held',
        't-x'
      )
    ).toBe('ran')
  })
})
