import { getDocumentAsync } from 'expo-document-picker'
import { File } from 'expo-file-system'

export async function importSshPrivateKey(signal: AbortSignal): Promise<string | null> {
  const result = await getDocumentAsync({ copyToCacheDirectory: true })
  if (result.canceled) {
    return null
  }
  const file = new File(result.assets[0].uri)
  try {
    if (signal.aborted) {
      return null
    }
    if (file.size > 32768) {
      throw new Error('Private key is too large.')
    }
    const text = await file.text()
    return signal.aborted ? null : text
  } finally {
    file.delete()
  }
}
