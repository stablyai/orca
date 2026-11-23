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
