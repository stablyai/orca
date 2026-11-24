import {
  isPluginNotificationClickUrl,
  type PluginNotificationClickAction
} from '../../../../shared/plugins/workers/plugin-host-api-notifications'
import { PluginHostCallError, type PluginHostCallScope } from './plugin-host-call-scope'
import type { PluginHostServices } from './plugin-host-method-bindings'

export type PluginOwnCommands = {
  owns(commandId: string): boolean
  run(pluginId: string, commandId: string): Promise<unknown>
}

/** notifications.show params as the runtime takes them, with onClick as a click handler. */
export function pluginNotification(
  params: { title: string; body?: string; onClick?: PluginNotificationClickAction },
  pluginId: string,
  services: Pick<PluginHostServices, 'desktop' | 'commands'>,
  scope: PluginHostCallScope
): { pluginId: string; title: string; body?: string; onClick?: () => void } {
  const { title, body, onClick } = params
  return {
    pluginId,
    title,
    body,
    ...(onClick
      ? { onClick: pluginNotificationClickHandler(onClick, pluginId, services, scope) }
      : {})
  }
}

/**
 * What a click on a plugin's notification runs. Checked when the notification is shown, so a
 * plugin learns of a bad target at once; re-checked on click, which may come long after.
 */
function pluginNotificationClickHandler(
  action: PluginNotificationClickAction,
  pluginId: string,
  services: Pick<PluginHostServices, 'desktop' | 'commands'>,
  scope: PluginHostCallScope
): () => void {
  let run: () => Promise<unknown>
  if ('url' in action) {
    const { url } = action
    // Re-checked here: the schema already refused other schemes, but this is the sink.
    if (!isPluginNotificationClickUrl(url)) {
      throw new PluginHostCallError('invalid_params', 'onClick.url must be an http: or https: URL')
    }
    // The person still confirms each new host, exactly as for shell.openExternal.
    run = async () => services.desktop?.openExternal(pluginId, url, scope)
  } else {
    const { command } = action
    const commands = services.commands
    if (!commands?.owns(command)) {
      throw new PluginHostCallError(
        'invalid_params',
        `onClick.command ${command} is not a command this plugin contributes`
      )
    }
    run = () => commands.run(pluginId, command)
  }
  return () => {
    void (async () => {
      scope.assertActive()
      await run()
    })().catch((error: unknown) => {
      scope.log?.(`notifications.show: click action failed: ${String(error)}`)
    })
  }
}
