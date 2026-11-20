export function ensureFixtureServer(options?: {
  onStart?: () => void
}): Promise<{ url: string; started: boolean }>
export function callFixtureServer(url: string, endpoint: string, body?: unknown): Promise<unknown>
export function stopFixtureServer(): Promise<boolean>
