const sshProviders = new Map();
export function registerSshFilesystemProvider(connectionId, provider) {
    sshProviders.set(connectionId, provider);
}
export function unregisterSshFilesystemProvider(connectionId) {
    sshProviders.delete(connectionId);
}
export function getSshFilesystemProvider(connectionId) {
    return sshProviders.get(connectionId);
}
