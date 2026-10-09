import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'

const STORAGE_KEY = 'orca:ssh-credential-ids'
const Schema = z.array(z.string().regex(/^[a-zA-Z0-9-]{1,80}$/))
let mutation: Promise<void> = Promise.resolve()
const drafts = new Set<string>()

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutation.then(operation)
  mutation = result.then(
    () => {},
    () => {}
  )
  return result
}

async function read(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  return raw === null ? [] : Schema.parse(JSON.parse(raw))
}

export function beginSshCredentialDraft(id: string): Promise<void> {
  drafts.add(id)
  return serialize(async () => {
    const ids = await read()
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...new Set([...ids, id])]))
  })
}

export function finishSshCredentialDraft(id: string): void {
  drafts.delete(id)
}

// The caller holds the host-metadata mutation queue until this sweep finishes.
export function pruneSshCredentialRegistry(
  keep: Set<string>,
  remove: (id: string) => Promise<void>
): Promise<void> {
  return serialize(async () => {
    const ids = await read()
    const retained: string[] = []
    for (const id of ids) {
      if (keep.has(id) || drafts.has(id)) {
        retained.push(id)
      } else {
        try {
          await remove(id)
        } catch {
          retained.push(id)
        }
      }
    }
    if (retained.length !== ids.length) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(retained))
    }
  })
}

export function hasSshCredentialCleanupCandidates(): Promise<boolean> {
  return serialize(async () => (await read()).some((id) => !drafts.has(id)))
}
