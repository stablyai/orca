import ActivityKit

struct OrcaSessionAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var state: String
    var title: String
    var stateStartedAt: Double
    var updatedAt: Double
  }

  var linkId: String
  var labels: [String: String]
}

struct OrcaAgentOverviewAttributes: ActivityAttributes {
  struct Counts: Codable, Hashable {
    var working: Int
    var attention: Int
    var done: Int
    var failed: Int
    var unavailable: Int
  }
  struct Session: Codable, Hashable, Identifiable {
    var id: String
    var segment: String
    var scopeId: String
    var renderId: String { scopeId + "." + id }
    var title: String
    var state: String
    var stateStartedAt: Double
  }
  struct ContentState: Codable, Hashable {
    var schemaVersion: Int
    var state: String
    var title: String
    var stateStartedAt: Double
    var updatedAt: Double
    var counts: Counts
    var sessions: [Session]
    var knownSources: Int
    var totalSources: Int
    var complete: Bool
  }
  var linkId: String
  var labels: [String: String]
}
