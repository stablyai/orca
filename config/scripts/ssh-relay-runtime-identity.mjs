import { createHash } from 'node:crypto'

function canonicalCompatibility(compatibility) {
  if (compatibility.kind === 'linux') {
    return {
      kind: compatibility.kind,
      minimumKernelVersion: compatibility.minimumKernelVersion,
      libc: {
        family: compatibility.libc.family,
        minimumVersion: compatibility.libc.minimumVersion,
        minimumLibstdcxxVersion: compatibility.libc.minimumLibstdcxxVersion,
        minimumGlibcxxVersion: compatibility.libc.minimumGlibcxxVersion
      }
    }
  }
  if (compatibility.kind === 'darwin') {
    return { kind: compatibility.kind, minimumVersion: compatibility.minimumVersion }
  }
  return {
    kind: compatibility.kind,
    minimumBuild: compatibility.minimumBuild,
    minimumOpenSshVersion: compatibility.minimumOpenSshVersion,
    minimumPowerShellVersion: compatibility.minimumPowerShellVersion,
    minimumDotNetFrameworkRelease: compatibility.minimumDotNetFrameworkRelease
  }
}

export function canonicalSshRelayRuntimeIdentityBytes(runtime) {
  const entries = [...runtime.entries]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((entry) =>
      entry.type === 'directory'
        ? { path: entry.path, type: entry.type, mode: entry.mode }
        : {
            path: entry.path,
            type: entry.type,
            role: entry.role,
            size: entry.size,
            mode: entry.mode,
            sha256: entry.sha256
          }
    )
  const projection = {
    identitySchemaVersion: 1,
    tupleId: runtime.tupleId,
    os: runtime.os,
    architecture: runtime.architecture,
    compatibility: canonicalCompatibility(runtime.compatibility),
    nodeVersion: runtime.nodeVersion,
    dependencies: {
      nodePtyVersion: runtime.dependencies.nodePtyVersion,
      parcelWatcherVersion: runtime.dependencies.parcelWatcherVersion
    },
    entries
  }
  return Buffer.from(JSON.stringify(projection), 'utf8')
}

export function computeSshRelayRuntimeContentId(runtime) {
  const hex = createHash('sha256')
    .update(canonicalSshRelayRuntimeIdentityBytes(runtime))
    .digest('hex')
  return `sha256:${hex}`
}
