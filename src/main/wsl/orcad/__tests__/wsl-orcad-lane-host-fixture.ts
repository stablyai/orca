import type { WslHostStatus } from '../../../../shared/wsl-host-types'
import { hasOrcadTemplate } from '../../../orcad/artifact-slots/orcad-artifact-materializer'
import { createWslHostConnector } from '../../host-lifecycle/wsl-host-connector'
import type { WslHostConnector } from '../../host-lifecycle/wsl-host-connector-contract'
import { WslHostService } from '../../host-lifecycle/wsl-host-service'

export type LaneWslHost = {
  service: WslHostService
  connector: WslHostConnector
  /** Everything the service published, as the window's status listener receives it. */
  published: WslHostStatus[]
}

/** The production service and connector, wired as wsl-host-handlers wires them minus Electron. */
export function createLaneWslHost(userDataPath: string): LaneWslHost {
  const published: WslHostStatus[] = []
  const service = new WslHostService({
    userDataPath: () => userDataPath,
    isEnabled: () => true,
    hasServerFiles: hasOrcadTemplate,
    publish: (status) => {
      published.push(status)
      console.log(`[lane] host ${JSON.stringify(status)}`)
    },
    pairingChanged: () => {},
    ready: () => {},
    removed: () => {}
  })
  const refuse = (): Promise<never> => Promise.reject(new Error('The lane never removes a host'))
  const connector = createWslHostConnector({
    userDataPath,
    onChange: service.handleConnectionChange.bind(service),
    hasUserVisibleWork: (distro) => service.hasUserVisibleWork(distro),
    isKnownDistro: (distro) => service.isKnownDistro(distro),
    runtime: { call: refuse, census: refuse }
  })
  service.attach(connector)
  return { service, connector, published }
}
