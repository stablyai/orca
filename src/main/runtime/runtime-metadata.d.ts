import { type RuntimeMetadata } from '../../shared/runtime-bootstrap';
export declare function writeRuntimeMetadata(userDataPath: string, metadata: RuntimeMetadata): void;
export declare function readRuntimeMetadata(userDataPath: string): RuntimeMetadata | null;
export declare function clearRuntimeMetadata(userDataPath: string): void;
