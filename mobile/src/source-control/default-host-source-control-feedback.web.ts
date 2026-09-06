import type { HostSourceControlFeedback } from './host-source-control-binding'

export const DEFAULT_HOST_SOURCE_CONTROL_FEEDBACK: HostSourceControlFeedback = {
  selection() {},
  success() {},
  error() {}
}
