import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentReadClosingLine, agentReadConnectionArgs } from './agent-read-continuation'

const SESSION = '3540ecf3-47c3-4876-b825-81bf5d6b3595'
const CURSOR = 'oar1_eyJ2IjoxfQ'
const HOSTILE = `it's "quoted" $(touch pwned) \`id\` ; | & > *`

afterEach(() => {
  vi.unstubAllEnvs()
})

/** The arguments a POSIX shell hands the program when it runs the printed command. */
function argvOf(line: string): string[] {
  const command = line.replace(/^Older: /, '')
  return execFileSync('sh', ['-c', `printf '%s\\0' ${command}`], { encoding: 'utf8' })
    .split('\0')
    .slice(0, -1)
}

describe('agentReadClosingLine', () => {
  it.skipIf(process.platform === 'win32')(
    'prints a command whose every argument reaches the program unchanged',
    () => {
      vi.stubEnv('ORCA_CLI_COMMAND', `/opt/my tools/${HOSTILE}`)
      const line = agentReadClosingLine(
        { orcaSessionId: SESSION, nextCursor: CURSOR },
        { limit: 5, connection: ['--environment', HOSTILE] }
      )!

      expect(argvOf(line)).toEqual([
        `/opt/my tools/${HOSTILE}`,
        'agent',
        'read',
        `orca_session_id:${SESSION}`,
        '--cursor',
        CURSOR,
        '--limit',
        '5',
        '--environment',
        HOSTILE
      ])
    }
  )

  it('never prints a host value it cannot keep inert, nor a pairing code', async () => {
    const connection = await agentReadConnectionArgs(new Map([['pairing-code', 'SECRET-CODE']]))
    const lines = [
      agentReadClosingLine(
        { orcaSessionId: SESSION, nextCursor: `${CURSOR}; touch pwned` },
        { limit: undefined, connection: [] }
      ),
      agentReadClosingLine(
        { orcaSessionId: `${SESSION}$(touch pwned)`, nextCursor: CURSOR },
        { limit: undefined, connection: [] }
      ),
      agentReadClosingLine(
        { orcaSessionId: SESSION, nextCursor: CURSOR },
        { limit: undefined, connection }
      )
    ]

    expect(connection).toBeNull()
    expect(lines).toEqual([
      "Older: the host returned a cursor Orca won't print; read with --json to get it.",
      `Older: --cursor ${CURSOR} (repeat your last command with this --cursor)`,
      `Older: --cursor ${CURSOR} (repeat your last command with this --cursor)`
    ])
  })
})
