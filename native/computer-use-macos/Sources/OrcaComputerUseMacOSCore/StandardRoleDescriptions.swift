import Foundation

/// The standard AX role descriptions HIServices ships, in every system language.
/// Why: AXRoleDescription comes back in the app's language, but role queries and render checks expect English.
public struct StandardRoleDescriptions: Sendable {
    /// Role, then lowercased description in any language, to its English description.
    private let englishByRole: [String: [String: String]]

    /// `tables` maps each localization to its descriptions, keyed by `role` or `role:subrole`.
    public init(tables: [String: [String: String]]) {
        let english = tables["en"] ?? tables["English"] ?? [:]
        var candidates: [String: [String: Set<String>]] = [:]
        for table in tables.values {
            for (key, description) in table {
                guard let englishDescription = english[key] else { continue }
                let role = String(key.prefix { $0 != ":" })
                candidates[role, default: [:]][description.lowercased(), default: []].insert(englishDescription)
            }
        }
        // Why: matching by role alone skips an AXSubrole read per node; a description two keys of one role share
        // is ambiguous without it, so the role's own wins and anything else stays as written.
        englishByRole = candidates.reduce(into: [:]) { result, entry in
            let roleEnglish = english[entry.key]
            result[entry.key] = entry.value.compactMapValues { matches in
                matches.count == 1 ? matches.first : roleEnglish.flatMap { matches.contains($0) ? $0 : nil }
            }
        }
    }

    /// Reads the table the running macOS localizes role descriptions from, so it matches what apps report.
    public static func system() -> StandardRoleDescriptions {
        let path = "/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework"
        guard let bundle = Bundle(path: path) else { return StandardRoleDescriptions(tables: [:]) }
        // Why: recent macOS ships every language in one .loctable; older releases keep a .strings file per .lproj.
        if let url = bundle.url(forResource: "RoleDescriptions", withExtension: "loctable"),
           let tables = NSDictionary(contentsOf: url) as? [String: Any] {
            return StandardRoleDescriptions(tables: tables.compactMapValues { $0 as? [String: String] })
        }
        let tables = bundle.localizations.compactMap { localization in
            bundle.url(forResource: "RoleDescriptions", withExtension: "strings", subdirectory: nil, localization: localization)
                .flatMap { NSDictionary(contentsOf: $0) as? [String: String] }
                .map { (localization, $0) }
        }
        return StandardRoleDescriptions(tables: Dictionary(tables, uniquingKeysWith: { first, _ in first }))
    }

    /// The English description when `description` is a standard one for the role or one of its subroles in any
    /// language. Other wording is the app's own and returns nil.
    public func english(role: String, description: String) -> String? {
        englishByRole[role]?[description.lowercased()]
    }
}
