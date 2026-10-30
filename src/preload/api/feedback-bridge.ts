import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type {
  FeedbackSubmitArgs,
  FeedbackSubmitResult
} from '../../shared/feedback-submit-contract'

export const feedbackApi = {
  submit: (args: FeedbackSubmitArgs): Promise<FeedbackSubmitResult> =>
    ipcRenderer.invoke('feedback:submit', args)
} satisfies PreloadApi['feedback']
