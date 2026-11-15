import type { CustomAppIconImportResult } from '../../../shared/app-icon'

export type AppIconApi = {
  importCustom: () => Promise<CustomAppIconImportResult | null>
  readCustomPreview: () => Promise<string | null>
  removeCustom: () => Promise<void>
}
