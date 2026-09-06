import { triggerError, triggerSelection, triggerSuccess } from '../platform/haptics'
import type { HostSourceControlFeedback } from './host-source-control-binding'

export const NATIVE_HOST_SOURCE_CONTROL_FEEDBACK: HostSourceControlFeedback = {
  selection: triggerSelection,
  success: triggerSuccess,
  error: triggerError
}
