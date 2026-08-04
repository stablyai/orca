import type { MemorySnapshot } from '../../shared/memory-snapshot'
import { readSnapshotFileThroughFilesystemHost } from '../filesystem-host/filesystem-host-read-authority'
import { classifyFilesystemSnapshotFailure, MemorySnapshotStore } from './memory-snapshot-store'
import { getGrokAuthPath, parseGrokAuthSession, type GrokAuthSession } from './grok-auth'

const authSnapshot = new MemorySnapshotStore<GrokAuthSession>()

export function getGrokAuthSnapshot(): MemorySnapshot<GrokAuthSession> {
  return authSnapshot.get()
}

export function invalidateGrokAuthSnapshot(): void {
  authSnapshot.invalidate()
}

export async function refreshGrokAuthSnapshot(): Promise<MemorySnapshot<GrokAuthSession>> {
  return authSnapshot.refresh(async () => {
    let contents: string
    try {
      contents = (
        await readSnapshotFileThroughFilesystemHost(getGrokAuthPath(), 'grok-auth')
      ).toString('utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { value: null, availability: 'missing' }
      }
      throw error
    }
    const result = parseGrokAuthSession(contents)
    if (result.status === 'ok') {
      return { value: result.session, availability: 'ready' }
    }
    if (result.status === 'missing') {
      return { value: null, availability: 'missing' }
    }
    throw new Error('Grok auth file is invalid')
  }, classifyFilesystemSnapshotFailure)
}
