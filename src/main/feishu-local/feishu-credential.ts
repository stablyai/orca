import { getSecretStore } from '../../shared/secure-storage/secret-store'
export function unsealFeishuCredential(sealed: string | null): string | null {
  try {
    return sealed ? getSecretStore().decryptString(Buffer.from(sealed, 'base64')) : null
  } catch {
    return null
  }
}
