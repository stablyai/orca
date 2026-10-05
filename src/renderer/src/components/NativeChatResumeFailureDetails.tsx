import { AlertCircle, Clock, X } from 'lucide-react'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  resumeFailureGuidance,
  type ResumeFailureAction
} from './native-chat-resume-failure-guidance'
import type { ResumeFailure } from './native-chat-resume-on-restart-grouping'

/**
 * What a failed row adds to an ordinary offered row: one status icon whose tooltip carries the
 * status and the host's reason, a dismiss control, and a "To resume" line with the button that does
 * it. Retry is offered only where a retry can succeed.
 */

function actionLabel(action: ResumeFailureAction): string {
  return action === 'open'
    ? translate('auto.components.NativeChatResumeOutcomeRow.openChat', 'Open chat')
    : action === 'retry'
      ? translate('auto.components.NativeChatResumeOutcomeRow.retry', 'Retry')
      : translate('auto.components.NativeChatResumeOutcomeRow.dismiss', 'Dismiss')
}

export function ResumeFailureStatus({
  failure,
  title,
  workspaceName,
  disabled,
  onAction
}: {
  failure: ResumeFailure
  title: string
  workspaceName: string
  disabled: boolean
  onAction: (action: ResumeFailureAction) => void
}): React.JSX.Element {
  const status =
    failure.outcome === 'unconfirmed'
      ? translate(
          'auto.components.NativeChatResumeOutcomeRow.unconfirmed',
          'Couldn’t confirm the chat was resumed'
        )
      : translate('auto.components.NativeChatResumeOutcomeRow.failed', 'Couldn’t resume')
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Focusable so keyboard users reach the same tooltip; the accessible name says which chat. */}
          <span
            tabIndex={0}
            role="img"
            aria-label={translate(
              'auto.components.NativeChatResumeOutcomeRow.statusFor',
              '{{value0}}: {{value1}}',
              { value0: title, value1: status }
            )}
            className="inline-flex shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {failure.outcome === 'unconfirmed' ? (
              <Clock className="size-3.5 text-muted-foreground" />
            ) : (
              <AlertCircle className="size-3.5 text-status-warning" />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-72">
          {status}
          {/* The code verbatim, so it can be quoted in a report. */}
          <span className="mt-0.5 block font-mono text-[10px] opacity-75">{failure.reason}</span>
        </TooltipContent>
      </Tooltip>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={disabled}
        aria-label={translate(
          'auto.components.NativeChatResumeOutcomeRow.dismissChat',
          'Dismiss "{{value0}}" in {{value1}}',
          { value0: title, value1: workspaceName }
        )}
        onClick={() => onAction('dismiss')}
      >
        <X className="size-3" />
      </Button>
    </>
  )
}

export function ResumeFailureGuidanceLine({
  failure,
  disabled,
  onAction
}: {
  failure: ResumeFailure
  disabled: boolean
  onAction: (action: ResumeFailureAction) => void
}): React.JSX.Element {
  const guidance = resumeFailureGuidance(failure)
  return (
    <div className="ml-6 mb-1 flex items-center gap-2 rounded-md border border-status-warning-border bg-status-warning-background px-2 py-1.5 text-[11px]">
      <span className="min-w-0 flex-1">
        <span className="font-semibold">
          {translate('auto.components.NativeChatResumeOutcomeRow.toResume', 'To resume:')}
        </span>{' '}
        {guidance.text}
      </span>
      <Button size="xs" disabled={disabled} onClick={() => onAction(guidance.primary)}>
        {actionLabel(guidance.primary)}
      </Button>
      {guidance.secondary && (
        <Button
          size="xs"
          variant="secondary"
          disabled={disabled}
          onClick={() => onAction(guidance.secondary!)}
        >
          {actionLabel(guidance.secondary)}
        </Button>
      )}
    </div>
  )
}
