import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('./bundled-skill-guides.js', () => ({
  BUNDLED_SKILL_GUIDES: [
    {
      name: 'alpha',
      description: 'Use when alpha work is needed.',
      markdown: '# Alpha\n\nShort.\n',
      fullMarkdown: '# Alpha\n\nShort.\n\n## References\n\nFull.\n',
      aliases: ['legacy-alpha'],
      references: [
        { name: 'first-gate', markdown: '# First gate\n\nDo the first thing.\n' },
        { name: 'second-gate', markdown: '# Second gate\n\nDo the second thing.\n' }
      ]
    },
    {
      name: 'zeta',
      description: 'Use when zeta work is needed.',
      markdown: '# Zeta\n',
      fullMarkdown: '# Zeta\n',
      aliases: [],
      references: []
    }
  ]
}))

vi.mock('./runtime-client', async () => {
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('./runtime/types.js')
  class RuntimeClient {
    constructor() {
      throw new Error('skills get constructed a RuntimeClient')
    }
  }
  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: vi.fn(),
    getDefaultUserDataPath: vi.fn(() => '/tmp/orca-user-data')
  }
})

import { main } from './index'

function stdoutText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}

describe('orca skills get --reference', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('prints only the named reference, with no kernel and no header', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'get', 'alpha', '--reference', 'second-gate'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe('# Second gate\n\nDo the second thing.\n')
  })

  it('accepts the references/<file>.md spelling the gate table prints', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'get', 'alpha', '--reference', 'references/first-gate.md'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe('# First gate\n\nDo the first thing.\n')
  })

  it('resolves a reference through a topic alias', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'get', 'legacy-alpha', '--reference', 'first-gate.md'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe('# First gate\n\nDo the first thing.\n')
  })

  it('gives --reference --json the canonical topic, reference name, and Markdown', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(
      ['skills', 'get', 'legacy-alpha', '--reference', 'references/first-gate.md', '--json'],
      '/tmp/repo'
    )

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          name: 'alpha',
          reference: 'first-gate',
          markdown: '# First gate\n\nDo the first thing.\n'
        },
        null,
        2
      )}\n`
    )
  })

  it('lists reference names for --references', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'get', 'alpha', '--references'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe('first-gate\nsecond-gate\n')
  })

  it('gives --references --json a stable schema', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'get', 'alpha', '--references', '--json'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify({ name: 'alpha', references: ['first-gate', 'second-gate'] }, null, 2)}\n`
    )
  })

  it('reports a topic that ships no references', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'get', 'zeta', '--references'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Guide "zeta" has no bundled references.')
  })

  it('names the available references for an unknown one', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'get', 'alpha', '--reference', 'nope'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Unknown reference "nope" for alpha. Available: first-gate, second-gate'
    )
  })

  it('rejects --reference on a topic with no references', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'get', 'zeta', '--reference', 'first-gate'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Guide "zeta" has no bundled references.')
  })

  it('rejects --reference without a value', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'get', 'alpha', '--reference'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Missing required --reference')
  })

  it('rejects combining --full with --reference', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'get', 'alpha', '--full', '--reference', 'first-gate'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Use either --full or --reference, not both.')
  })

  it('rejects combining --references with --full or --reference', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'get', 'alpha', '--references', '--full'], '/tmp/repo')
    await main(['skills', 'get', 'alpha', '--references', '--reference', 'first-gate'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenNthCalledWith(1, 'Use either --references or --full, not both.')
    expect(errorSpy).toHaveBeenNthCalledWith(2, 'Use either --references or --reference, not both.')
  })

  it('still serves the kernel and the full package unchanged', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'get', 'alpha'], '/tmp/repo')
    await main(['skills', 'get', 'alpha', '--full'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      '# Alpha\n\nShort.\n# Alpha\n\nShort.\n\n## References\n\nFull.\n'
    )
  })
})
