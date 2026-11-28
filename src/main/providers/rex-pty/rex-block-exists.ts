import { rexListedSessions, rexListedBlocks } from './rex-rpc-schema'
import type { RexControl } from './rex-control'

export async function rexBlockExists(
  connection: RexControl,
  sessionId: string,
  blockId: string
): Promise<boolean> {
  const sessions = await connection.call('session.list', {}, rexListedSessions.parse)
  if (!sessions.sessions?.some((session) => session.session_id === sessionId)) {
    return false
  }
  await connection.call('session.attach', { session_id: sessionId })
  const blocks = await connection.call(
    'session.list_blocks',
    { session_id: sessionId },
    rexListedBlocks.parse
  )
  return blocks.blocks?.some((block) => block.block_id === blockId) ?? false
}
