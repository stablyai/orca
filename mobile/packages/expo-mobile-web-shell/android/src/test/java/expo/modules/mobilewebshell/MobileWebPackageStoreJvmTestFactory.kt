package expo.modules.mobilewebshell

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Base64

internal fun jvmMobileWebPackageStore(
  cacheRoot: File,
  availableStorageBytes: (File) -> Long = { it.usableSpace },
  replaceActivation: (source: File, destination: File) -> Unit = { source, destination ->
    Files.move(
      source.toPath(),
      destination.toPath(),
      StandardCopyOption.ATOMIC_MOVE,
      StandardCopyOption.REPLACE_EXISTING
    )
  }
): MobileWebPackageStore =
  MobileWebPackageStore(
    cacheRoot,
    availableStorageBytes,
    replaceActivation,
    decodeBase64 = { Base64.getDecoder().decode(it) },
    encodeBase64 = { Base64.getEncoder().encodeToString(it) }
  )
