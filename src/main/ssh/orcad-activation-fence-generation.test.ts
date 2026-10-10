import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'

// Every remote command runs in a real local shell, so the host-side checks are the real ones.
const shell = vi.hoisted((): { env: NodeJS.ProcessEnv | undefined } => ({ env: undefined }))
vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => {
  const { runProcess } = await import('@orca/process-host')
  return {
    ...(await importOriginal<typeof DeployHelpers>()),
    execCommand: async (_conn: unknown, command: string) => {
      const result = await runProcess({ program: '/bin/sh', args: ['-c', command], env: shell.env })
      if (result.code !== 0) {
        const { sshCommandExitError } = await import('./ssh-relay-exec-command')
        throw sshCommandExitError(command, result.code ?? 1, result.stdout)
      }
      return result.stdout
    }
  }
})

const { withOrcadActivationLock } = await import('./orcad-activation-lock')
const { orcadActivationFenceRefusal } = await import('./orcad-activation-fence-hold')
const { execOrcadRemote } = await import('./orcad-remote-runtime-control')
const { OrcadFenceLostError, runWithOrcadFence } = await import('./orcad-activation-fence-scope')
const { execOrcadStateMutation } = await import('./orcad-state-mutation-exec')
const { clearOrcadStateSnapshotMembersCommand } = await import('./orcad-state-snapshot')
const { getRemoteHostPlatform } = await import('./ssh-remote-platform')

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

// Astra pass 8: a holder suspended past the stale window resumed, kept acting, and its release
// deleted the successor's fence and recovery journal mid-update.
describe.skipIf(process.platform === 'win32')('a superseded activation fence holder', () => {
  it('can neither act nor release once a successor took its fence over', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orcad-fence-gen-'))
    homes.push(home)
    const root = join(home, '.orca-remote', '.orcad-activation-transaction')
    const fence = join(root, '.install-lock')
    const journal = join(root, 'transaction.json')
    const launched = join(home, 'launched-by-stale-holder')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked to a local shell, so the connection is never used.
    const conn = {} as never
    const options = { conn, host: getRemoteHostPlatform('linux-x64'), remoteHome: home }

    let resumeStale!: () => void
    let staleEntered = false
    const stale = withOrcadActivationLock(
      options,
      async () => {
        staleEntered = true
        await new Promise<void>((resolve) => (resumeStale = resolve))
        // Resumed: it still believes it holds the fence and tries to start its slot.
        await execOrcadRemote(options, `touch '${launched}'`)
        return 'acted'
      },
      () => 'held'
    )
    await vi.waitFor(() => expect(staleEntered).toBe(true))
    // Suspended past the stale window: nothing refreshes its fence.
    utimesSync(fence, new Date(0), new Date(0))
    expect(await orcadActivationFenceRefusal(options, 'update')).toMatchObject({ cleared: true })

    let resumeSuccessor!: () => void
    let successorEntered = false
    const successor = withOrcadActivationLock(
      options,
      async () => {
        // As the journal store writes it: stamped with the writing generation.
        writeFileSync(
          journal,
          JSON.stringify({ phase: 'mid-update', fenceToken: 'successor' }, null, 2)
        )
        successorEntered = true
        await new Promise<void>((resolve) => (resumeSuccessor = resolve))
        return 'done'
      },
      () => 'held',
      'successor'
    )
    await vi.waitFor(() => expect(successorEntered).toBe(true))

    resumeStale()
    await expect(stale).rejects.toBeInstanceOf(OrcadFenceLostError)
    expect(existsSync(launched)).toBe(false)
    // The successor's fence and journal survive the stale holder's release.
    expect(existsSync(fence)).toBe(true)
    expect(existsSync(journal)).toBe(true)

    resumeSuccessor()
    expect(await successor).toBe('done')
    expect(existsSync(fence)).toBe(false)
    expect(existsSync(journal)).toBe(false)
  })

  // Astra pass 9: a release already past its token check stalled, a takeover and a successor
  // came and went, and the resumed release deleted the successor's journal and lock.
  it('leaves a successor’s journal and lock when its own release resumes after a stall', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orcad-fence-release-'))
    homes.push(home)
    const root = join(home, '.orca-remote', '.orcad-activation-transaction')
    const fence = join(root, '.install-lock')
    const journal = join(root, 'transaction.json')
    const bin = join(home, 'bin')
    const ready = join(home, 'ready')
    const resume = join(home, 'resume')
    mkdirSync(bin)
    // Stalls the first move of the journal, the release step right after its token check.
    writeFileSync(
      join(bin, 'mv'),
      `#!/bin/sh\nif [ "$1" = '${journal}' ] && [ ! -f '${ready}' ]; then touch '${ready}'; while [ ! -f '${resume}' ]; do sleep 0.05; done; fi\nexec /bin/mv "$@"\n`
    )
    chmodSync(join(bin, 'mv'), 0o755)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked to a local shell, so the connection is never used.
    const conn = {} as never
    const options = { conn, host: getRemoteHostPlatform('linux-x64'), remoteHome: home }
    shell.env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
    let finishSuccessor: (() => void) | undefined
    let successor: Promise<unknown> | undefined
    const first = withOrcadActivationLock(
      options,
      async () => 'first',
      () => 'held',
      'first'
    )
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true))
      utimesSync(fence, new Date(0), new Date(0))
      expect(await orcadActivationFenceRefusal(options, 'update')).toMatchObject({ cleared: true })
      successor = withOrcadActivationLock(
        options,
        async () => {
          writeFileSync(journal, JSON.stringify({ fenceToken: 'successor' }, null, 2))
          await new Promise<void>((resolve) => (finishSuccessor = resolve))
          return 'done'
        },
        () => 'held',
        'successor'
      )
      await vi.waitFor(() => expect(finishSuccessor).toBeDefined())
      writeFileSync(resume, '')
      expect(await first).toBe('first')
      expect(readFileSync(join(fence, '.orca-fence-owner'), 'utf8')).toBe('successor')
      expect(readFileSync(journal, 'utf8')).toContain('"fenceToken": "successor"')
    } finally {
      writeFileSync(resume, '')
      await first.catch(() => {})
      finishSuccessor?.()
      await successor
      shell.env = undefined
    }
  })

  // Astra pass 9 §3: a state mutation from a superseded run must not run either.
  it('refuses a superseded run’s state mutation before it touches profile state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orcad-fence-mutation-'))
    homes.push(home)
    const base = join(home, '.orca-remote')
    const root = join(home, 'root')
    const lockDir = join(base, '.orcad-activation-transaction', '.install-lock')
    mkdirSync(lockDir, { recursive: true })
    mkdirSync(join(root, 'profiles'), { recursive: true })
    writeFileSync(join(lockDir, '.orca-fence-owner'), 'successor')
    writeFileSync(join(root, 'profiles', 'state.json'), 'successor-state')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked to a local shell, so the connection is never used.
    const conn = {} as never
    const options = { conn, host: getRemoteHostPlatform('linux-x64'), remoteHome: home }
    await expect(
      runWithOrcadFence({ lockDir, token: 'stale' }, () =>
        execOrcadStateMutation(
          options,
          clearOrcadStateSnapshotMembersCommand(options.host, root, base)
        )
      )
    ).rejects.toBeInstanceOf(OrcadFenceLostError)
    expect(readFileSync(join(root, 'profiles', 'state.json'), 'utf8')).toBe('successor-state')
  })
})
