import { Info, X } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { translate } from '@/i18n/i18n'
import { useCodexSharedSettingsNotice } from './terminal-pane/codex-shared-settings-notice'

/** A persistent one-time notice, so it sits with the other cards rather than as a sticky toast. */
export function CodexSharedSettingsNoticeCard(): React.JSX.Element | null {
  const { visible, dismiss } = useCodexSharedSettingsNotice()
  if (!visible) {
    return null
  }
  return (
    <Card role="complementary" aria-labelledby="codex-shared-settings-notice-heading">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Info className="size-4 text-muted-foreground" />
            <CardTitle id="codex-shared-settings-notice-heading">
              {translate(
                'terminal.codexSharedSettingsNotice.title',
                'Codex in Orca now uses ~/.codex'
              )}
            </CardTitle>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={dismiss}
            aria-label={translate('terminal.codexSharedSettingsNotice.dismiss', 'Dismiss')}
          >
            <X />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <CardDescription>
          {translate(
            'terminal.codexSharedSettingsNotice.description',
            'Codex may ask again to trust folders or approve commands. Re-add any MCP servers you added only in Orca.'
          )}
        </CardDescription>
      </CardContent>
    </Card>
  )
}
