import type { HerdrPtyBinding } from './herdr-pty-types'
import type { PtyProcessInfo } from '../../types'
import {
  getHerdrBindingCwd,
  getHerdrBindingForegroundProcess,
  getHerdrBindingProcessInfo,
  herdrBindingHasChildProcesses
} from './herdr-pty-binding-queries'

export async function getHerdrCwd(binding: HerdrPtyBinding): Promise<string> {
  return await getHerdrBindingCwd(binding)
}

export async function getHerdrForegroundProcess(binding: HerdrPtyBinding): Promise<string | null> {
  return await getHerdrBindingForegroundProcess(binding)
}

export async function getHerdrProcessInfo(binding: HerdrPtyBinding): Promise<PtyProcessInfo> {
  return await getHerdrBindingProcessInfo(binding)
}

export async function herdrHasChildProcesses(binding: HerdrPtyBinding): Promise<boolean> {
  return await herdrBindingHasChildProcesses(binding)
}
