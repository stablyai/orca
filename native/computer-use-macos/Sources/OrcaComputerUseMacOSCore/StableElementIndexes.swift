import Foundation

/// Keeps an element's index across snapshots of the same window, so action results can send only
/// the lines that changed.
public enum StableElementIndexes {
    /// Only matching AX identities keep their indexes; all other elements receive fresh indexes.
    public static func assign<Key: Hashable>(
        current: [Key],
        previous: [(key: Key, index: Int)],
        previousNextFreshIndex: Int
    ) -> (indexes: [Int], nextFreshIndex: Int) {
        let previousIndexByKey = Dictionary(previous.map { ($0.key, $0.index) }, uniquingKeysWith: { first, _ in first })
        var claimed = Set<Int>()
        var assigned = current.map { element -> Int? in
            guard let index = previousIndexByKey[element], claimed.insert(index).inserted else { return nil }
            return index
        }
        var nextFreshIndex = max(previousNextFreshIndex, (previous.map(\.index).max() ?? -1) + 1)
        for position in assigned.indices where assigned[position] == nil {
            assigned[position] = nextFreshIndex
            nextFreshIndex += 1
        }
        return (assigned.compactMap { $0 }, nextFreshIndex)
    }

    /// Rewrites the leading `<tabs><index>` of a rendered element line; other lines pass through.
    public static func renumber(line: String, indexes: [Int: Int]) -> String {
        let tabs = line.prefix { $0 == "\t" }
        let rest = line.dropFirst(tabs.count)
        let digits = rest.prefix { $0.isASCII && $0.isNumber }
        guard !digits.isEmpty,
              rest.dropFirst(digits.count).first.map({ $0 == " " }) ?? true,
              let old = Int(digits),
              let new = indexes[old]
        else {
            return line
        }
        return "\(tabs)\(new)\(rest.dropFirst(digits.count))"
    }
}
