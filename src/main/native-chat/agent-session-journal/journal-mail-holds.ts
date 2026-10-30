import type { JournalMailCut } from './journal-mail-boundary'

export type MailStopCapture = { cut?: JournalMailCut; finished?: () => void }
export type CaptureSessionMail = () => MailStopCapture
