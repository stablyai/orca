export function encodeNdjson(msg) {
    return `${JSON.stringify(msg)}\n`;
}
export function createNdjsonParser(onMessage, onError) {
    let buffer = '';
    return {
        feed(chunk) {
            buffer += chunk;
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                if (line.length === 0) {
                    continue;
                }
                try {
                    onMessage(JSON.parse(line));
                }
                catch (err) {
                    onError?.(err instanceof Error ? err : new Error(String(err)));
                }
            }
        },
        reset() {
            buffer = '';
        }
    };
}
