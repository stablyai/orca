import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import {
  CursorAcpRequestError,
  openCursorAcpConnection,
  type CursorAcpConnection
} from './cursor-acp-connection'
import { createCursorAcpSession, type CursorAcpSession } from './cursor-acp-session'

it.runIf(process.env.ORCA_REAL_CURSOR_ACP_TEST === '1')(
  'checks installed Cursor ACP and same-session context when existing authentication is available',
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-real-cursor-acp-'))
    const command = resolveCliCommand(process.env.ORCA_REAL_CURSOR_ACP_COMMAND ?? 'cursor-agent', {
      pathEnv: process.env.PATH,
      homePath: homedir()
    })
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value
      }
    }
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      CURSOR_CONFIG_DIR: join(root, 'cursor'),
      CURSOR_DATA_DIR: join(root, 'cursor-data'),
      NODE_COMPILE_CACHE: join(root, 'compile-cache'),
      ORCA_BACKGROUND_LAUNCH: '1'
    })
    const proof: Record<string, unknown> = { command, homeIsolated: true, liveModelResponse: false }
    let connection: CursorAcpConnection | null = null
    let session: CursorAcpSession | null = null
    let text = ''
    const create = (sessionId?: string) =>
      createCursorAcpSession({
        launch: { command, args: ['acp'], env },
        cwd: root,
        ...(sessionId ? { sessionId } : {}),
        openConnection: async (launch, handlers) => {
          connection = await openCursorAcpConnection(launch, handlers)
          proof.initialize = { protocolVersion: 1, capabilities: connection.capabilities }
          return connection
        },
        events: {
          update: (update, replay) => {
            if (
              !replay &&
              update.sessionUpdate === 'agent_message_chunk' &&
              typeof update.content === 'object' &&
              update.content !== null &&
              'text' in update.content &&
              typeof update.content.text === 'string'
            ) {
              text += update.content.text
            }
          },
          request: (request) => {
            if (request.method === 'session/request_permission') {
              connection?.respond(request.id, { outcome: { outcome: 'cancelled' } })
            } else {
              connection?.respondWithError(
                request.id,
                -32601,
                'This isolated proof does not offer client tools'
              )
            }
          }
        }
      })
    try {
      try {
        session = await create()
      } catch (error) {
        if (
          error instanceof CursorAcpRequestError &&
          error.method === 'session/new' &&
          error.code === -32000 &&
          error.message.includes('Authentication required')
        ) {
          proof.sessionNew = 'authentication-required'
          context.skip(
            'Installed Cursor ACP requires authentication; no login or credential transfer performed'
          )
        }
        throw error
      }
      const sessionId = session.sessionId
      proof.sessionId = sessionId
      expect(
        await session.prompt(
          [
            {
              type: 'text',
              text: 'Reply with exactly CURSOR_ACP_INITIAL. Do not use tools or read or change files.'
            }
          ],
          60_000
        )
      ).toBe('end_turn')
      expect(text.trim()).toBe('CURSOR_ACP_INITIAL')
      proof.liveModelResponse = true
      expect(await session.close()).toBe(true)
      text = ''
      session = await create(sessionId)
      expect(session.sessionId).toBe(sessionId)
      expect(
        await session.prompt(
          [
            {
              type: 'text',
              text: 'What exact marker did I ask you to reply with before this restart? Reply with only that marker. Do not use tools or read or change files.'
            }
          ],
          60_000
        )
      ).toBe('end_turn')
      expect(text.trim()).toBe('CURSOR_ACP_INITIAL')
      proof.sameSessionContextRestored = true
    } finally {
      if (session) {
        expect(await session.close()).toBe(true)
      }
      if (process.env.ORCA_CURSOR_ACP_PROOF_PATH) {
        await writeFile(process.env.ORCA_CURSOR_ACP_PROOF_PATH, JSON.stringify(proof, null, 2))
      }
      await rm(root, { recursive: true, force: true })
    }
  },
  150_000
)
