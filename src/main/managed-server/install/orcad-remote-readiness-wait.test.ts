import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { orcadReadinessWaitCommand } from './orcad-remote-readiness-wait'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { ORCAD_LAUNCH_MACHINE_COMMAND } from './orcad-remote-host-support'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('the host-side readiness wait', () => {
  it('ends by its wall-clock deadline however slow each poll is', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-readiness-wait-'))
    roots.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'wc'), '#!/bin/sh\nsleep 0.5\nexec /usr/bin/wc "$@"\n')
    chmodSync(join(bin, 'wc'), 0o755)
    const slot = join(root, 'slot')
    mkdirSync(slot)
    const command = orcadReadinessWaitCommand(getRemoteHostPlatform('linux-x64'), slot, 2)
    const startedAt = Date.now()
    await runProcess({
      program: '/bin/sh',
      args: ['-c', command],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      timeoutMs: 30_000
    })
    // Counted polling would take about 8 × (0.25 s + 1 s), exceeding the client timeout.
    expect(Date.now() - startedAt).toBeLessThan(4_500)
  })

  async function waitAfter(gone: boolean, machine: 'here' | 'elsewhere' | 'unrecorded') {
    const root = mkdtempSync(join(tmpdir(), 'orcad-readiness-wait-'))
    roots.push(root)
    const slot = join(root, 'slot')
    mkdirSync(slot)
    const pidFile = quotePosixShell(join(slot, '.orcad-pid'))
    const machineFile = quotePosixShell(join(slot, '.orcad-pid-machine'))
    const command = orcadReadinessWaitCommand(getRemoteHostPlatform('linux-x64'), slot, 2)
    const prefix = [
      gone ? `sh -c 'echo $$ > "$1"' orcad-test ${pidFile};` : `echo ${process.pid} > ${pidFile};`,
      ...(machine === 'here'
        ? [`{ ${ORCAD_LAUNCH_MACHINE_COMMAND};} > ${machineFile} 2>/dev/null;`]
        : machine === 'elsewhere'
          ? [`echo 'other-boot other-node' > ${machineFile};`]
          : [])
    ].join(' ')
    const { stdout } = await runProcess({
      program: '/bin/sh',
      args: ['-c', `${prefix} ${command}`],
      timeoutMs: 30_000
    })
    return stdout.startsWith('ORCAD_LAUNCH_EXITED\n')
  }

  // Only Linux has the boot id that makes a PID evidence; elsewhere the wait keeps its deadline.
  it.skipIf(process.platform !== 'linux')(
    'ends at once when the launched PID is gone here',
    async () => {
      expect(await waitAfter(true, 'here')).toBe(true)
    }
  )

  it.each([
    ['waits while the launched PID still runs', false, 'here'],
    ['waits for a PID another machine sharing the home launched', true, 'elsewhere'],
    ['waits for a launch that recorded no machine', true, 'unrecorded']
  ] as const)('%s', async (_case, gone, machine) => {
    expect(await waitAfter(gone, machine)).toBe(false)
  })
})
