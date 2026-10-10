import type { ExpoIrohNativeModule } from './types'

const notImplemented = async (): Promise<never> => {
  throw new Error('iroh_web_not_implemented')
}

const ExpoIrohModule: ExpoIrohNativeModule = {
  irohStart: notImplemented,
  irohConnect: notImplemented,
  irohSend: notImplemented,
  irohPathInfo: notImplemented,
  irohClose: notImplemented,
  irohStop: notImplemented,
  addListener: () => ({ remove: () => undefined }),
  removeListeners: () => undefined
}

export default ExpoIrohModule
