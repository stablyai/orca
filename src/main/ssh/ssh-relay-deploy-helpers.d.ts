import type { SFTPWrapper, ClientChannel } from 'ssh2';
import type { SshConnection } from './ssh-connection';
import type { MultiplexerTransport } from './ssh-channel-multiplexer';
export declare function uploadDirectory(sftp: SFTPWrapper, localDir: string, remoteDir: string): Promise<void>;
export declare function mkdirSftp(sftp: SFTPWrapper, path: string): Promise<void>;
export declare function uploadFile(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void>;
export declare function waitForSentinel(channel: ClientChannel): Promise<MultiplexerTransport>;
export declare function execCommand(conn: SshConnection, command: string): Promise<string>;
export declare function resolveRemoteNodePath(conn: SshConnection): Promise<string>;
