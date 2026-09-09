import React from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Field } from './automation-page-parts'
import { translate } from '@/i18n/i18n'

type SendNotificationActionFieldsProps = {
  config: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
}

function readString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

export function SendNotificationActionFields({
  config,
  onChange
}: SendNotificationActionFieldsProps): React.JSX.Element {
  const channel = readString(config, 'channel')
  const message = readString(config, 'message')

  return (
    <div className="space-y-3">
      <Field
        label={translate(
          'auto.components.automations.SendNotificationActionFields.a5b6c7d8e9',
          'Channel'
        )}
      >
        <Input
          value={channel}
          onChange={(event) => onChange({ ...config, channel: event.target.value })}
          placeholder={translate(
            'auto.components.automations.SendNotificationActionFields.b6c7d8e9f0',
            'default'
          )}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.automations.SendNotificationActionFields.c7d8e9f0a1',
          // Why: F11's own doc (docs/features/F11-notifications.md) has no
          // fixed channel taxonomy for this RPC — the agent's real handler
          // (notification-send-handler.ts) treats `channel` as a free-text
          // label prefixed onto the OS notification title, defaulting to
          // "default" when empty. Confirmed by reading that handler
          // directly rather than inventing a dropdown that doesn't match
          // any real enum.
          'A free-text label shown in the notification title — not a fixed list of channels.'
        )}
      </p>
      <Field
        label={translate(
          'auto.components.automations.SendNotificationActionFields.d8e9f0a1b2',
          'Message'
        )}
      >
        <Textarea
          value={message}
          onChange={(event) => onChange({ ...config, message: event.target.value })}
          placeholder={translate(
            'auto.components.automations.SendNotificationActionFields.e9f0a1b2c3',
            'Notification message'
          )}
          className="min-h-[4rem]"
        />
      </Field>
    </div>
  )
}
