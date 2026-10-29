import { useState, useSyncExternalStore } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { ClaudeAccountSwitchSessionTree } from './ClaudeAccountSwitchSessionTree'
import {
  answerClaudeAccountSwitchPrompt,
  getClaudeAccountSwitchPrompt,
  subscribeClaudeAccountSwitchPrompt,
  type ClaudeAccountSwitchPrompt
} from '@/lib/claude-account-switch-sessions'

export default function ClaudeAccountSwitchDialog(): React.JSX.Element | null {
  const prompt = useSyncExternalStore(
    subscribeClaudeAccountSwitchPrompt,
    getClaudeAccountSwitchPrompt,
    getClaudeAccountSwitchPrompt
  )
  // Reset selections and the preference checkbox for each new switch prompt.
  return prompt ? <SwitchPromptDialog key={prompt.id} prompt={prompt} /> : null
}

function SwitchPromptDialog({ prompt }: { prompt: ClaudeAccountSwitchPrompt }): React.JSX.Element {
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const { onAccount, elsewhere, cantMove } = prompt.sessions
  // Only sessions on the outgoing account start ticked.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(onAccount.map((session) => session.ptyId))
  )
  const listedCount = onAccount.length + elsewhere.length + cantMove.length
  const chosen = [...onAccount, ...elsewhere]
    .map((session) => session.ptyId)
    .filter((ptyId) => ticked.has(ptyId))
  const toggle = (ptyId: string, checked: boolean): void => {
    setTicked((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(ptyId)
      } else {
        next.delete(ptyId)
      }
      return next
    })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Closing keeps sessions as-is without undoing the account switch.
        if (!open) {
          answerClaudeAccountSwitchPrompt('keep', { dontAskAgain })
        }
      }}
    >
      <DialogContent
        data-session-list={listedCount > 1}
        className="sm:max-w-md sm:data-[session-list=true]:max-w-lg"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('accounts.claude.switchSessions.title', 'Switched to {{account}}', {
              account: prompt.nextAccountLabel
            })}
          </DialogTitle>
          <DialogDescription>{promptDescription(prompt)}</DialogDescription>
        </DialogHeader>
        {(listedCount > 1 || prompt.review) && (
          <ClaudeAccountSwitchSessionTree
            sessions={prompt.sessions}
            previousAccountLabel={prompt.previousAccountLabel}
            selected={ticked}
            onToggle={toggle}
          />
        )}
        {/* Why hidden on review: restarting automatically is already the setting. */}
        {!prompt.review && (
          <label className="flex min-w-0 items-start gap-2.5">
            <Checkbox
              checked={dontAskAgain}
              onCheckedChange={(checked) => setDontAskAgain(checked === true)}
              className="mt-0.5"
            />
            <span className="min-w-0 space-y-0.5">
              <span className="block text-sm">
                {translate(
                  'accounts.claude.switchSessions.dontAskAgain',
                  "Don't ask again (restart automatically)"
                )}
              </span>
              <span className="block text-xs text-muted-foreground">
                {translate(
                  'accounts.claude.switchSessions.dontAskAgainHint',
                  'You can turn this off in Settings → AI Provider Accounts.'
                )}
              </span>
            </span>
          </label>
        )}
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => answerClaudeAccountSwitchPrompt('keep', { dontAskAgain })}
          >
            {translate('accounts.claude.switchSessions.keep', 'Keep as is')}
          </Button>
          <Button
            type="button"
            size="sm"
            autoFocus
            disabled={chosen.length === 0}
            onClick={() =>
              answerClaudeAccountSwitchPrompt('restart', { ptyIds: chosen, dontAskAgain })
            }
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {chosen.length <= 1
              ? translate('accounts.claude.switchSessions.restartOne', 'Restart session')
              : chosen.length === 1
                ? translate(
                    'accounts.claude.switchSessions.restartCount_one',
                    'Restart {{count}} session',
                    { count: chosen.length }
                  )
                : translate(
                    'accounts.claude.switchSessions.restartCount_other',
                    'Restart {{count}} sessions',
                    { count: chosen.length }
                  )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function promptDescription(prompt: ClaudeAccountSwitchPrompt): string {
  const { onAccount, elsewhere, cantMove } = prompt.sessions
  const next = prompt.nextAccountLabel
  if (prompt.review) {
    const count = elsewhere.length + cantMove.length
    return count === 1
      ? translate(
          'accounts.claude.switchSessions.reviewBody_one',
          "{{count}} other Claude session wasn't moved to {{next}}.",
          { count, next }
        )
      : translate(
          'accounts.claude.switchSessions.reviewBody_other',
          "{{count}} other Claude sessions weren't moved to {{next}}.",
          { count, next }
        )
  }
  const accounts = { count: onAccount.length, previous: prompt.previousAccountLabel, next }
  return onAccount.length === 1
    ? translate(
        'accounts.claude.switchSessions.body_one',
        '{{count}} Claude session is still running on {{previous}}. Restarting continues the conversation on {{next}}. Busy sessions wait for idle before restarting.',
        accounts
      )
    : translate(
        'accounts.claude.switchSessions.body_other',
        '{{count}} Claude sessions are still running on {{previous}}. Restarting continues each conversation on {{next}}. Busy sessions wait for idle before restarting.',
        accounts
      )
}
