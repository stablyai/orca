import Darwin

public enum UnixSocketPathSafety {
    public static func isSocketMode(_ mode: mode_t) -> Bool {
        (mode & mode_t(S_IFMT)) == mode_t(S_IFSOCK)
    }

    public static func shouldRejectExistingPathAfterBindFailure(
        bindErrno: Int32,
        existingMode: mode_t?
    ) -> Bool {
        bindErrno == EADDRINUSE && existingMode.map { !isSocketMode($0) } == true
    }
}
