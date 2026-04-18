const sshProviders = new Map();
export function registerSshGitProvider(connectionId, provider) {
    sshProviders.set(connectionId, provider);
}
export function unregisterSshGitProvider(connectionId) {
    sshProviders.delete(connectionId);
}
export function getSshGitProvider(connectionId) {
    return sshProviders.get(connectionId);
}
