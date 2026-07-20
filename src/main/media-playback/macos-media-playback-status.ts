import { execFile } from 'node:child_process'
import type {
  MediaPlaybackPlayer,
  MediaPlaybackState,
  MediaPlaybackStatus
} from '../../shared/media-playback-status'

const CACHE_TTL_MS = 3_000
const PROCESS_PROBE_TIMEOUT_MS = 1_000
const APPLE_SCRIPT_TIMEOUT_MS = 2_000
const FIELD_SEPARATOR = '\u001f'

type CommandOptions = {
  timeout: number
  maxBuffer: number
}

export type MediaPlaybackCommandRunner = (
  file: string,
  args: string[],
  options: CommandOptions
) => Promise<{ stdout: string }>

type PlayerDescriptor = {
  player: MediaPlaybackPlayer
  processName: string
  appleScript: string
}

const PLAYERS: readonly PlayerDescriptor[] = [
  {
    player: 'spotify',
    processName: 'Spotify',
    appleScript: `tell application id "com.spotify.client"
set playerState to player state as string
set artistName to ""
set trackName to ""
try
set artistName to artist of current track
end try
try
set trackName to name of current track
end try
return playerState & (ASCII character 31) & artistName & (ASCII character 31) & trackName
end tell`
  },
  {
    player: 'apple-music',
    processName: 'Music',
    appleScript: `tell application id "com.apple.Music"
set playerState to player state as string
set artistName to ""
set trackName to ""
try
set artistName to artist of current track
end try
try
set trackName to name of current track
end try
return playerState & (ASCII character 31) & artistName & (ASCII character 31) & trackName
end tell`
  }
]

function runCommand(
  file: string,
  args: string[],
  options: CommandOptions
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout })
    })
  })
}

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeState(value: string | undefined): MediaPlaybackState {
  const state = normalizeText(value).toLowerCase()
  if (state === 'playing' || state === 'paused') {
    return state
  }
  return 'stopped'
}

export function parseMediaPlaybackOutput(
  player: MediaPlaybackPlayer,
  output: string
): MediaPlaybackStatus | null {
  const trimmed = output.trimEnd()
  if (!trimmed) {
    return null
  }
  const [state, artist, track] = trimmed.split(FIELD_SEPARATOR)
  return {
    player,
    state: normalizeState(state),
    artist: normalizeText(artist),
    track: normalizeText(track)
  }
}

async function queryPlayer(
  descriptor: PlayerDescriptor,
  commandRunner: MediaPlaybackCommandRunner
): Promise<MediaPlaybackStatus | null> {
  try {
    // Why: addressing a missing or closed scriptable app can launch it or raise
    // an Automation prompt, so only query players already running on this Mac.
    await commandRunner('/usr/bin/pgrep', ['-x', descriptor.processName], {
      timeout: PROCESS_PROBE_TIMEOUT_MS,
      maxBuffer: 1_024
    })
    const { stdout } = await commandRunner('/usr/bin/osascript', ['-e', descriptor.appleScript], {
      timeout: APPLE_SCRIPT_TIMEOUT_MS,
      maxBuffer: 8_192
    })
    return parseMediaPlaybackOutput(descriptor.player, stdout)
  } catch {
    return null
  }
}

export function selectMediaPlaybackStatus(
  statuses: readonly (MediaPlaybackStatus | null)[],
  previousPlayer: MediaPlaybackPlayer | null
): MediaPlaybackStatus | null {
  const available = statuses.filter((status): status is MediaPlaybackStatus => status !== null)
  const spotify = available.find((status) => status.player === 'spotify') ?? null
  const appleMusic = available.find((status) => status.player === 'apple-music') ?? null

  if (spotify?.state === 'playing') {
    return spotify
  }
  if (appleMusic?.state === 'playing') {
    return appleMusic
  }
  return available.find((status) => status.player === previousPlayer) ?? spotify ?? appleMusic
}

type MediaPlaybackReaderOptions = {
  platform?: NodeJS.Platform
  commandRunner?: MediaPlaybackCommandRunner
  now?: () => number
}

export function createMediaPlaybackStatusReader(
  options: MediaPlaybackReaderOptions = {}
): () => Promise<MediaPlaybackStatus | null> {
  const platform = options.platform ?? process.platform
  const commandRunner = options.commandRunner ?? runCommand
  const now = options.now ?? Date.now
  let previousPlayer: MediaPlaybackPlayer | null = null
  let cached: { expiresAt: number; status: MediaPlaybackStatus | null } | null = null
  let inFlight: Promise<MediaPlaybackStatus | null> | null = null

  return async () => {
    if (platform !== 'darwin') {
      return null
    }
    if (cached && now() < cached.expiresAt) {
      return cached.status
    }
    if (inFlight) {
      return inFlight
    }

    inFlight = Promise.all(PLAYERS.map((player) => queryPlayer(player, commandRunner))).then(
      (statuses) => {
        const status = selectMediaPlaybackStatus(statuses, previousPlayer)
        if (status) {
          previousPlayer = status.player
        }
        cached = { expiresAt: now() + CACHE_TTL_MS, status }
        return status
      }
    )

    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }
}

export const getMediaPlaybackStatus = createMediaPlaybackStatusReader()
