import { expect, it } from 'vitest'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { readMailboxForeground } from './mailbox-foreground-read'

const confirmations = { count: 0 }
const read = (
  processName: string | null,
  stoppedAgents?: string[],
  agent: TuiAgent | undefined = 'claude',
  confirmedName = processName
) =>
  readMailboxForeground(
    {
      getForegroundProcess: async () => processName,
      confirmForegroundProcess: async () => {
        confirmations.count += 1
        return confirmedName
      },
      supportsForegroundObservation: () => true,
      inspectProcess: async () => ({
        foregroundProcess: processName,
        hasChildProcesses: true,
        foregroundObservation: {
          ptyId: 'pty-1',
          ptyIncarnationId: 'incarnation-1',
          authorityGeneration: 'test',
          observationEpoch: 1,
          capturedAgeMs: 0,
          verdict: 'observed' as const,
          source: 'pty-master' as const,
          foregroundKind: 'non-shell' as const,
          processName,
          ...(stoppedAgents ? { stoppedAgents } : {})
        }
      })
    },
    { remote: false, windows: false },
    'pty-1',
    agent,
    'incarnation-1'
  )

it('another program in front stands in for the agent only while that agent is stopped on this terminal', async () => {
  await expect(read('cat', ['claude'])).resolves.toMatchObject({ foreground: 'non-shell' })
  await expect(read('/usr/bin/ssh', ['claude'])).resolves.toMatchObject({ foreground: 'non-shell' })
  await expect(read(null, ['claude'])).resolves.toMatchObject({ foreground: 'non-shell' })
  await expect(read('cat', ['codex', 'claude'])).resolves.toMatchObject({ foreground: 'non-shell' })
  await expect(read('tmux', ['claude'], undefined)).resolves.toMatchObject({
    foreground: 'non-shell'
  })
})

it('with no stopped agent here, a program in front may be relaying to the agent and proves nothing', async () => {
  await expect(read('cat')).resolves.toMatchObject({ foreground: 'unknown' })
  await expect(read('tmux: client')).resolves.toMatchObject({ foreground: 'unknown' })
  await expect(read('sudo')).resolves.toMatchObject({ foreground: 'unknown' })
  await expect(read('cat', ['codex'])).resolves.toMatchObject({ foreground: 'unknown' })
  await expect(read('tmux', undefined, undefined)).resolves.toMatchObject({ foreground: 'unknown' })
})

it('a plainly named program in front is judged without a host-wide confirmation', async () => {
  confirmations.count = 0
  for (let terminal = 0; terminal < 100; terminal++) {
    await expect(read('vim', ['claude'])).resolves.toMatchObject({ foreground: 'non-shell' })
  }
  expect(confirmations.count).toBe(0)
})

it('an unrecognized name with the expected agent not stopped is still confirmed, so the returning agent is seen', async () => {
  confirmations.count = 0
  await expect(read('agent-native', undefined, 'claude', 'claude')).resolves.toMatchObject({
    foreground: 'agent'
  })
  expect(confirmations.count).toBe(1)
})
