import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = 'orca:watch-spike:results'
const MAX_RESULTS = 30

export type WatchActionSpikeStep = { step: string; ms: number; detail?: string }

export type WatchActionSpikeResult = {
  at: number
  action: string
  replyText?: string
  appState: string
  /** Native tap record to JS handling; null when the native ledger missed the tap. */
  nativeToJsMs: number | null
  outcome: 'reached' | 'failed' | 'stale'
  failedStep?: string
  totalMs: number
  path?: string
  steps: WatchActionSpikeStep[]
  log: string[]
}

export async function readWatchActionSpikeResults(): Promise<WatchActionSpikeResult[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as WatchActionSpikeResult[]) : []
  } catch {
    return []
  }
}

export async function appendWatchActionSpikeResult(result: WatchActionSpikeResult): Promise<void> {
  const results = await readWatchActionSpikeResults()
  await AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([result, ...results].slice(0, MAX_RESULTS))
  )
}

export async function clearWatchActionSpikeResults(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY)
}
