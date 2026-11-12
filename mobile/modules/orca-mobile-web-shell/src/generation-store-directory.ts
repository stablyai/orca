import { requireOptionalNativeModule } from 'expo-modules-core'

// <name> under the app's durable storage (iOS Application Support, outside backups; Android filesDir) as a file URL.
// Null from a binary built before the function existed, or when the directory can't be made.
export function generationStoreDirectory(name: string): string | null {
  const shell = requireOptionalNativeModule<{
    generationStoreDirectory?: (name: string) => string
  }>('OrcaMobileWebShell')
  try {
    return shell?.generationStoreDirectory?.(name) ?? null
  } catch {
    return null
  }
}
