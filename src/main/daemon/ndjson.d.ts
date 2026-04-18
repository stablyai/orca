export declare function encodeNdjson(msg: unknown): string;
export type NdjsonParser = {
    feed(chunk: string): void;
    reset(): void;
};
export declare function createNdjsonParser(onMessage: (msg: unknown) => void, onError?: (err: Error) => void): NdjsonParser;
