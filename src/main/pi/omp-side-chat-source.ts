import { OMP_SIDE_CHAT_DIR_ENV } from '../../shared/agent-launch/side-chat/omp-side-chat-session'
import { SIDE_CHAT_CONTEXT } from '../../shared/agent-launch/side-chat/side-chat'

export const OMP_SIDE_CHAT_BOUNDARY_CUSTOM_TYPE = 'orca-side-chat-boundary'

// Why plain pi.on: the lead session consumes the env first, so task children never see a dir to claim or delete.
export function getOmpSideChatHandlerSourceLines(): string[] {
  return [
    '  let sideChatDir: string | undefined',
    "  pi.on('session_start', async (_event, ctx) => {",
    `    const dir = process.env.${OMP_SIDE_CHAT_DIR_ENV}`,
    '    if (!dir) return',
    '    // Bash tools and nested omp must not inherit the side-chat identity.',
    `    delete process.env.${OMP_SIDE_CHAT_DIR_ENV}`,
    "    const file = typeof ctx?.sessionManager?.getSessionFile === 'function' ? ctx.sessionManager.getSessionFile() : undefined",
    "    if (typeof file !== 'string' || !file.startsWith(dir)) return",
    '    const separator = file[dir.length]',
    "    if (separator !== '/' && separator !== '\\\\') return",
    '    sideChatDir = dir',
    '    try {',
    `      await pi.sendMessage({ customType: ${JSON.stringify(OMP_SIDE_CHAT_BOUNDARY_CUSTOM_TYPE)}, content: ${JSON.stringify(SIDE_CHAT_CONTEXT)}, display: false })`,
    '    } catch {}',
    '  })',
    '  // Side chats are ephemeral; omp does not recreate the folder after shutdown.',
    "  pi.on('session_shutdown', () => {",
    '    if (!sideChatDir) return',
    '    try {',
    "      require('fs').rmSync(sideChatDir, { recursive: true, force: true })",
    '    } catch {}',
    '  })'
  ]
}
