/**
 * Where older relays bound their socket when `$HOME` pushed the default path past
 * `sockaddr_un.sun_path` (#10726): a fixed-length per-uid base under `/tmp`. The host census
 * still lists endpoints there.
 */
export const SHORT_RELAY_SOCKET_DIR_PREFIX = '/tmp/.orca-relay-'
