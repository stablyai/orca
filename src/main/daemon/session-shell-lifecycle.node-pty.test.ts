import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPtySubprocess } from './pty-subprocess'
import { Session } from './session'
import { inspectTerminalHostProcess } from './terminal-host-process-inspection'

describe.skipIf(process.platform === 'win32')('managed Bash lifecycle on a real PTY', () => {
  it('does not export the private binding to an unsupported shell', async () => {
    const subprocess = await createPtySubprocess({
      sessionId: 'unsupported-lifecycle',
      cols: 80,
      rows: 24,
      shellOverride: '/bin/sh',
      env: { _ORCA_SHELL_LIFECYCLE_BINDING: 'caller-value' }
    })
    const current = new Session({
      sessionId: 'unsupported-lifecycle',
      cols: 80,
      rows: 24,
      subprocess,
      shellReadySupported: false
    })
    let output = ''
    current.attachClient({
      onData: (data) => {
        output += data
      },
      onExit() {}
    })
    try {
      current.write('printf "ENV_STATE:%s\\n" "${_ORCA_SHELL_LIFECYCLE_BINDING-unset}"\r')
      await vi.waitFor(() => expect(output).toContain('ENV_STATE:unset'))
      expect(await current.shellLifecycle.observe('no-children')).toMatchObject({
        phase: 'unknown'
      })
    } finally {
      await current.forceKillAndWaitForExit(3_000)
      current.dispose()
    }
  })
  it.each([
    [false, false, false, false],
    [true, false, false, false],
    [false, true, false, false],
    [false, false, true, false],
    [false, false, false, true]
  ])(
    'observes prompt/read-e/prompt with functrace=%s xtrace=%s noclobber=%s allexport=%s',
    async (functrace, xtrace, noclobber, allexport) => {
      const home = mkdtempSync(join(tmpdir(), 'orca-shell-lifecycle-'))
      const originalUserData = process.env.ORCA_USER_DATA_PATH
      process.env.ORCA_USER_DATA_PATH = join(home, 'orca-data')
      writeFileSync(
        join(home, '.bash_profile'),
        `PS1='LIFECYCLE_PROMPT> '\nunset HISTFILE\n${functrace ? 'set -T' : ''}\n${xtrace ? 'set -x' : ''}\n${noclobber ? 'set -C' : ''}\n/bin/bash -c 'if [[ -n "\${__orca_lifecycle_binding+x}\${__orca_lifecycle_state+x}" ]]; then printf "%s%s" PRIVATE_EXPORT_ LEAK; fi'\n`
      )
      let session: Session | undefined
      let output = ''
      let lifecycleStatePath: string | undefined
      try {
        const subprocess = await createPtySubprocess({
          sessionId: 'lifecycle-fixture',
          cols: 80,
          rows: 24,
          cwd: home,
          shellOverride: '/bin/bash',
          command: ':',
          env: {
            HOME: home,
            SHELL: '/bin/bash',
            TERM: 'xterm-256color',
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            ...(allexport ? { SHELLOPTS: 'allexport' } : {})
          }
        })
        lifecycleStatePath = subprocess.shellLifecycleStatePath
        const current = new Session({
          sessionId: 'lifecycle-fixture',
          cols: 80,
          rows: 24,
          subprocess,
          shellReadySupported: true
        })
        session = current
        current.attachClient({
          onData: (data) => {
            output += data
          },
          onExit() {}
        })
        const expectShellPrompt = () =>
          expect(
            output.endsWith('LIFECYCLE_PROMPT> ') ||
              output.endsWith('LIFECYCLE_PROMPT> \x1b]777;orca-shell-ready\x07')
          ).toBe(true)
        await vi.waitFor(expectShellPrompt, { timeout: 5_000 })
        expect(await current.shellLifecycle.observe('no-children')).toEqual(
          expect.objectContaining({ phase: functrace ? 'unknown' : 'prompt' })
        )
        const returnToPrompt = async (answer: string) => {
          const count = output.split('LIFECYCLE_PROMPT> ').length
          current.write(answer)
          await vi.waitFor(
            () => {
              expect(output.split('LIFECYCLE_PROMPT> ').length).toBeGreaterThan(count)
              expectShellPrompt()
            },
            { timeout: 5_000 }
          )
          await vi.waitFor(async () =>
            expect((await current.shellLifecycle.observe('no-children')).phase).toBe(
              functrace ? 'unknown' : 'prompt'
            )
          )
        }
        const inspect = () =>
          inspectTerminalHostProcess({
            sessionId: 'lifecycle-fixture',
            session: current,
            currentSession: () => current,
            expectedIncarnationId: current.incarnationId,
            includeShellLifecycle: true,
            authorityGeneration: 'fixture-host',
            nextObservationEpoch: () => 1
          })
        if (!functrace) {
          expect((await inspect()).shellLifecycle).toEqual(
            expect.objectContaining({
              phase: 'prompt',
              ptyIncarnationId: current.incarnationId,
              authorityGeneration: 'fixture-host'
            })
          )
        }
        current.write("read -e -r -p 'READ_ACTIVE> ' answer\r")
        expect(await current.shellLifecycle.observe('no-children')).toMatchObject({
          phase: 'unknown'
        })
        await vi.waitFor(() => expect(output).toMatch(/READ_ACTIVE> $/))
        if (functrace) {
          expect((await current.shellLifecycle.observe('no-children')).phase).not.toBe('prompt')
        } else {
          expect((await current.shellLifecycle.observe('no-children')).phase).toBe('running')
        }
        expect((await inspect()).shellLifecycle?.phase).not.toBe('prompt')
        const foreign = await inspectTerminalHostProcess({
          sessionId: 'lifecycle-fixture',
          session: current,
          currentSession: () => current,
          expectedIncarnationId: 'different-incarnation',
          includeShellLifecycle: true,
          authorityGeneration: 'fixture-host',
          nextObservationEpoch: () => 2
        })
        expect(foreign.shellLifecycle).toMatchObject({ phase: 'unknown', confidence: 'none' })
        const changed = await inspectTerminalHostProcess({
          sessionId: 'lifecycle-fixture',
          session: current,
          currentSession: () => undefined,
          includeShellLifecycle: true,
          authorityGeneration: 'fixture-host',
          nextObservationEpoch: () => 3
        })
        expect(changed.shellLifecycle).toMatchObject({
          phase: 'unknown',
          reason: 'session-changed'
        })

        // Raw prompt markers emitted by a running command cannot acquire prompt authority.
        await returnToPrompt('done\r')
        current.write('sleep 30\r')
        await vi.waitFor(async () => expect((await inspect()).foregroundProcess).toBe('sleep'), {
          timeout: 5_000
        })
        expect((await inspect()).shellLifecycle?.phase).not.toBe('prompt')
        await returnToPrompt('\x03')
        const mismatched = await inspectTerminalHostProcess({
          sessionId: 'lifecycle-fixture',
          session: current,
          currentSession: () => current,
          expectedIncarnationId: 'retired-incarnation',
          includeShellLifecycle: true,
          authorityGeneration: 'fixture-host',
          nextObservationEpoch: () => 2
        })
        expect(mismatched.shellLifecycle).toMatchObject({ phase: 'unknown' })
        current.write("printf '\\033]133;A\\007'; read -e -r -p 'SECOND_ACTIVE> ' answer\r")
        await vi.waitFor(() => expect(output).toMatch(/SECOND_ACTIVE> $/))
        if (functrace) {
          expect((await current.shellLifecycle.observe('no-children')).phase).not.toBe('prompt')
        } else {
          expect((await current.shellLifecycle.observe('no-children')).phase).toBe('running')
        }
        await returnToPrompt('done\r')
        expect(output).not.toContain('orca-shell-lifecycle;')
        expect(output).not.toContain('PRIVATE_EXPORT_LEAK')
        expect(Boolean(subprocess.shellLifecycleBinding)).toBe(true)
        expect(output.includes(subprocess.shellLifecycleBinding ?? '')).toBe(false)
        expect(lifecycleStatePath).toEqual(expect.any(String))
        expect(output).not.toContain(lifecycleStatePath)
      } finally {
        if (session) {
          await session.forceKillAndWaitForExit(3_000)
          session.dispose()
          if (lifecycleStatePath) {
            expect(existsSync(lifecycleStatePath)).toBe(false)
          }
        }
        if (originalUserData === undefined) {
          delete process.env.ORCA_USER_DATA_PATH
        } else {
          process.env.ORCA_USER_DATA_PATH = originalUserData
        }
        rmSync(home, { recursive: true, force: true })
      }
    },
    15_000
  )
})
