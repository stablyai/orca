import { posix } from 'node:path'

const DISCORD_IPC_SLOT_COUNT = 10

// Why: sandboxed Linux builds expose the socket under their own runtime subdirectory.
const LINUX_SANDBOX_SUBDIRS = [
  'app/com.discordapp.Discord',
  'app/com.discordapp.DiscordCanary',
  'app/dev.vencord.Vesktop',
  'snap.discord',
  'snap.discord-canary'
]

/** Candidate Discord IPC endpoints, in the order clients are expected to probe them. */
export function getDiscordIpcSocketPaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  const slots = Array.from({ length: DISCORD_IPC_SLOT_COUNT }, (_, slot) => slot)
  if (platform === 'win32') {
    return slots.map((slot) => `\\\\?\\pipe\\discord-ipc-${slot}`)
  }
  const base = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp'
  const dirs = [base]
  if (platform === 'linux') {
    dirs.push(...LINUX_SANDBOX_SUBDIRS.map((subdir) => posix.join(base, subdir)))
  }
  const paths = dirs.flatMap((dir) => slots.map((slot) => posix.join(dir, `discord-ipc-${slot}`)))
  return [...new Set(paths)]
}
