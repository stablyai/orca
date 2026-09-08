import Foundation

func readMobileWebFile(
  _ url: URL,
  within cacheRoot: URL,
  byteLimit: Int,
  overflowCode: String
) throws -> Data {
  do {
    try requireMobileWebRegularFile(url, within: cacheRoot, errorCode: overflowCode)
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var data = Data()
    data.reserveCapacity(byteLimit + 1)
    while data.count <= byteLimit {
      let remaining = byteLimit + 1 - data.count
      guard
        remaining > 0,
        let chunk = try handle.read(upToCount: min(64 * 1024, remaining)),
        !chunk.isEmpty
      else {
        break
      }
      data.append(chunk)
    }
    guard data.count <= byteLimit else {
      throw MobileWebStoreError(overflowCode)
    }
    return data
  } catch let error as MobileWebStoreError {
    throw error
  } catch {
    throw MobileWebStoreError(overflowCode)
  }
}

func requireMobileWebRegularFile(
  _ url: URL,
  within cacheRoot: URL,
  errorCode: String
) throws {
  guard isMobileWebUnlinkedPath(url, within: cacheRoot) else {
    throw MobileWebStoreError(errorCode)
  }
  let values = try url.resourceValues(forKeys: [.isRegularFileKey])
  guard values.isRegularFile == true else {
    throw MobileWebStoreError(errorCode)
  }
}

func isMobileWebUnlinkedPath(_ url: URL, within cacheRoot: URL) -> Bool {
  let root = cacheRoot.standardizedFileURL
  let file = url.standardizedFileURL
  let resolvedRoot = root.resolvingSymlinksInPath().standardizedFileURL
  if file.path == root.path {
    return file.resolvingSymlinksInPath().standardizedFileURL.path == resolvedRoot.path
  }
  let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
  guard file.path.hasPrefix(prefix) else { return false }
  let relativePath = String(file.path.dropFirst(prefix.count))
  let expected = relativePath.split(separator: "/").reduce(resolvedRoot) { parent, component in
    parent.appendingPathComponent(String(component), isDirectory: false)
  }
  let resolvedFile = file.resolvingSymlinksInPath().standardizedFileURL
  return resolvedFile.path == expected.standardizedFileURL.path
}
