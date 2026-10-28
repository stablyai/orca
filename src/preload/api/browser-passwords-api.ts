import type {
  BrowserPasswordCopyResult,
  BrowserPasswordEntrySummary,
  BrowserPasswordFieldBlurEvent,
  BrowserPasswordFieldFocusEvent,
  BrowserPasswordFillOutcome,
  BrowserPasswordImportResult,
  BrowserPasswordEntryDetailsResult,
  BrowserPasswordEntryEditResult,
  BrowserPasswordEntryInput,
  BrowserPasswordSavePrompt,
  BrowserPasswordSavePromptResponse,
  BrowserPasswordsStatus
} from '../../shared/browser-passwords-types'

type ProfileArgs = { browserProfileId: string }
type EntryArgs = ProfileArgs & { entryId: string }

export type BrowserPasswordsApi = {
  getStatus: (args: ProfileArgs) => Promise<BrowserPasswordsStatus | null>
  list: (args: ProfileArgs) => Promise<BrowserPasswordEntrySummary[] | null>
  getEntryDetails: (args: EntryArgs) => Promise<BrowserPasswordEntryDetailsResult>
  addEntry: (
    args: ProfileArgs & BrowserPasswordEntryInput
  ) => Promise<BrowserPasswordEntryEditResult>
  updateEntry: (
    args: EntryArgs & Omit<BrowserPasswordEntryInput, 'site'>
  ) => Promise<BrowserPasswordEntryEditResult>
  deleteAll: (args: ProfileArgs) => Promise<boolean>
  copyPassword: (args: EntryArgs) => Promise<BrowserPasswordCopyResult>
  deleteEntry: (args: EntryArgs) => Promise<boolean>
  listNever: (args: ProfileArgs) => Promise<string[] | null>
  removeNever: (args: ProfileArgs & { origin: string }) => Promise<boolean>
  importCsv: (args: ProfileArgs) => Promise<BrowserPasswordImportResult>
  importFromBrowser: (
    args: ProfileArgs & { browserFamily: string; profileDirectory: string }
  ) => Promise<BrowserPasswordImportResult>
  respondSavePrompt: (response: BrowserPasswordSavePromptResponse) => Promise<boolean>
  fillLogin: (args: {
    browserPageId: string
    fieldToken: string
    entryId: string
  }) => Promise<BrowserPasswordFillOutcome>
  onSavePrompt: (callback: (prompt: BrowserPasswordSavePrompt) => void) => () => void
  onSavePromptClosed: (callback: (event: { promptId: string }) => void) => () => void
  onFieldFocus: (callback: (event: BrowserPasswordFieldFocusEvent) => void) => () => void
  onFieldBlur: (callback: (event: BrowserPasswordFieldBlurEvent) => void) => () => void
}
