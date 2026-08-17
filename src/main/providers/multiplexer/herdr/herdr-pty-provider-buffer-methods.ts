import type { HerdrPtyBinding } from './herdr-pty-types'
import type { PtyProviderBufferSnapshot } from '../../types'
import { getHerdrBindingBufferSnapshot } from './herdr-pty-binding-queries'

export async function getHerdrBufferSnapshot(
  binding: HerdrPtyBinding,
  scrollbackRows?: number
): Promise<PtyProviderBufferSnapshot | null> {
  return await getHerdrBindingBufferSnapshot(binding, scrollbackRows)
}
