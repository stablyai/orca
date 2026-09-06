package expo.modules.twowayaudio

internal fun writeAudioSampleFully(
    sample: ByteArray,
    isActive: () -> Boolean,
    awaitWritable: () -> Boolean = { true },
    retryNoProgress: () -> Boolean = { false },
    write: (offset: Int, length: Int) -> Int,
    onWrite: (bytes: Int) -> Unit
): Int {
    var offset = 0
    while (offset < sample.size && isActive()) {
        if (!awaitWritable()) {
            break
        }
        val remaining = sample.size - offset
        val written = write(offset, remaining)
        if (written == 0 && retryNoProgress()) {
            continue
        }
        if (written !in 1..remaining) {
            break
        }
        offset += written
        onWrite(written)
    }
    return offset
}
