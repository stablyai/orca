import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { Store } from '../../persistence/loading-store/store'
import { runtimeConversationHost } from '../../external-conversations/external-conversation-runtime-host'
import {
  installDingTalkLocalConnector,
  type DingTalkLocalConnector
} from '../../dingtalk-local/dingtalk-local-connector'

let connector: DingTalkLocalConnector | null = null

export function installMainProcessDingTalkLocal(
  runtime: OrcaRuntimeService,
  store: Store,
  userDataPath: string,
  registerCleanup: (cleanup: () => void) => void
): void {
  connector?.stop().catch(() => undefined)
  connector = installDingTalkLocalConnector({
    userDataPath,
    seam: () => runtime.getExternalConversationSeam(),
    host: () => runtimeConversationHost(runtime),
    bots: () => store.getBots()
  })
  void connector.start().catch((error: unknown) => {
    console.error('[dingtalk-local] startup failed', error)
  })
  registerCleanup(() => {
    const active = connector
    connector = null
    void active?.stop().catch((error: unknown) => {
      console.error('[dingtalk-local] shutdown failed', error)
    })
  })
}

export function mainProcessDingTalkLocal(): DingTalkLocalConnector | null {
  return connector
}
