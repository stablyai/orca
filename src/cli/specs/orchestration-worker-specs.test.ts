import { describe, expect, it } from 'vitest'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { formatCommandHelp } from '../help'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from './orchestration-worker-specs'

function workerStartHelp(): string {
  const spec = ORCHESTRATION_WORKER_COMMAND_SPECS.find(
    (entry) => entry.path.join(' ') === 'orchestration worker-start'
  )
  if (!spec) {
    throw new Error('Missing worker-start command')
  }
  return formatCommandHelp(spec)
}

describe('worker-start agent discovery help', () => {
  it('renders every registered agent exactly once, including OMP', () => {
    const help = workerStartHelp()
    const registered = help.match(/Registered --agent ids: (.+)\./)?.[1].split(', ')
    expect(registered).toEqual(Object.keys(TUI_AGENT_CONFIG))
    expect(registered).toContain('omp')
    expect(new Set(registered).size).toBe(registered?.length)
  })

  it('distinguishes registration from execution-host availability and supports aliases', () => {
    const help = workerStartHelp()
    expect(help).toContain('--agent must be enabled on the worker server')
    expect(help).toContain('configured single-executable command aliases are also accepted')
    expect(help).toContain(
      'Registered ids do not verify CLI installation, credentials, or provider availability on that execution host.'
    )
    expect(help).toContain('OMP accepts --model only; --effort is unsupported')
  })
})
