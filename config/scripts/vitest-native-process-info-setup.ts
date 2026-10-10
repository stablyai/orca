/**
 * Keep existing resize subprocess mocks in charge even when the checkout has built its addon.
 * Native suites load it by path or inject it with setNativeProcessInfoForTests.
 */
process.env.ORCA_DISABLE_NATIVE_PROCESS_INFO = '1'
