import Foundation

public enum AgentConnectionRequestLoop {
    /// Serves request lines until `readLine` returns nil or `handle` returns false.
    public static func run(readLine: () -> String?, handle: (String) -> Bool) {
        var keepServing = true
        while keepServing {
            // Why: a connection thread outlives its requests; without a per-request pool, objects
            // autoreleased while encoding a screenshot keep its WindowServer buffer until disconnect.
            keepServing = autoreleasepool {
                guard let line = readLine() else { return false }
                return handle(line)
            }
        }
    }
}
