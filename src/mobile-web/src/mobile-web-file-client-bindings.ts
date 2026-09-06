import type { MobileWebFileRequestClient } from './mobile-web-file-request-client'

export function mobileWebFileClientBindings(client: MobileWebFileRequestClient) {
  return {
    fileList: client.list.bind(client),
    fileSearch: client.search.bind(client),
    fileDirectory: client.directory.bind(client),
    fileRead: client.read.bind(client),
    fileReadChunk: client.readChunk.bind(client),
    fileWrite: client.write.bind(client),
    fileOpen: client.open.bind(client),
    fileResolveTerminalPath: client.resolveTerminalPath.bind(client),
    fileReadTerminalArtifactChunk: client.readTerminalArtifactChunk.bind(client),
    fileReleaseTerminalArtifact: client.releaseTerminalArtifact.bind(client)
  }
}
