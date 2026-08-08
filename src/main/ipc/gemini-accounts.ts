import type { ManagedCliHomeAccountService } from '../provider-managed-homes/service'
import { registerManagedProviderHomeHandlers } from './provider-managed-home-handlers'

export function registerGeminiAccountHandlers(service: ManagedCliHomeAccountService): void {
  registerManagedProviderHomeHandlers('geminiAccounts', service, 'Gemini')
}
