import type { HerdrPtyBinding } from './herdr-pty-types'
import type { PtyProviderBufferSnapshot } from '../../types'
import { getHerdrBindingBufferSnapshot } from './herdr-pty-binding-queries'

export async function getHerdrBufferSnapshot(
  binding: HerdrPtyBinding,
  scrollbackRows: number | undefined,
  source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'
): Promise<PtyProviderBufferSnapshot | null> {
  return await getHerdrBindingBufferSnapshot(binding, scrollbackRows, source)
}
