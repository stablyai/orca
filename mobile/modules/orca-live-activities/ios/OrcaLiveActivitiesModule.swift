import ActivityKit
import ExpoModulesCore
import UIKit

public class OrcaLiveActivitiesModule: Module {
  private struct ActivityWatch {
    let generation: UUID
    let task: Task<Void, Never>
  }

  private var watches: [String: ActivityWatch] = [:]
  private var isDestroyed = false
  private let lock = NSRecursiveLock()
  private let recordsKey = "orca.liveActivities.routes"

  public func definition() -> ModuleDefinition {
    Name("OrcaLiveActivities")
    Events("onToken", "onState")
    AsyncFunction("environment") { () -> String in
      Bundle.main.object(forInfoDictionaryKey: "OrcaActivityAPNsEnvironment") as? String ?? "sandbox"
    }
    AsyncFunction("hasTurn") { (route: [String: String]) -> Bool in
      self.records().values.contains { stored in route.allSatisfy { stored[$0.key] == $0.value } }
    }
    AsyncFunction("authorization") { () -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }
    AsyncFunction("activities") { () -> [[String: Any]] in
      for activity in Activity<OrcaSessionAttributes>.activities { self.watch(activity) }
      return Activity<OrcaSessionAttributes>.activities.map { activity in
        ["activityId": activity.id, "linkId": activity.attributes.linkId,
         "token": activity.pushToken.map(self.hex) ?? "", "state": String(describing: activity.activityState)]
      }
    }
    AsyncFunction("forgetRoute") { (linkId: String) in
      self.lock.lock()
      defer { self.lock.unlock() }
      var records = self.records()
      records.removeValue(forKey: linkId)
      UserDefaults.standard.set(records, forKey: self.recordsKey)
    }
    AsyncFunction("route") { (linkId: String) -> [String: String]? in
      self.records()[linkId]
    }
    AsyncFunction("start") { (linkId: String, route: [String: String], title: String, labels: [String: String]) -> String in
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        throw NSError(domain: "OrcaLiveActivities", code: 1)
      }
      let active = await MainActor.run { UIApplication.shared.applicationState == .active }
      guard active else { throw NSError(domain: "OrcaLiveActivities", code: 2) }
      let now = Date().timeIntervalSince1970
      let activity = try Activity.request(
        attributes: OrcaSessionAttributes(linkId: linkId, labels: labels),
        content: ActivityContent(state: OrcaSessionAttributes.ContentState(
          state: "working", title: title, stateStartedAt: now, updatedAt: now
        ), staleDate: Date().addingTimeInterval(900)),
        pushType: .token
      )
      self.storeRoute(linkId, route)
      self.watch(activity)
      return activity.id
    }
    AsyncFunction("end") { (activityId: String) in
      if let activity = Activity<OrcaSessionAttributes>.activities.first(where: { $0.id == activityId }) {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      self.cancelWatch(activityId)
    }
    OnDestroy {
      self.lock.lock()
      self.isDestroyed = true
      let pending = Array(self.watches.values)
      self.watches.removeAll()
      self.lock.unlock()
      for watch in pending { watch.task.cancel() }
    }
  }

  private func records() -> [String: [String: String]] {
    lock.lock()
    defer { lock.unlock() }
    return UserDefaults.standard.dictionary(forKey: recordsKey) as? [String: [String: String]] ?? [:]
  }

  private func storeRoute(_ id: String, _ route: [String: String]) {
    lock.lock()
    defer { lock.unlock() }
    var saved = records()
    let live = Set(Activity<OrcaSessionAttributes>.activities.map { $0.attributes.linkId })
    if saved.count >= 64, let oldest = saved.filter({ !live.contains($0.key) })
      .min(by: { ($0.value["createdAt"] ?? "") < ($1.value["createdAt"] ?? "") })?.key {
      saved.removeValue(forKey: oldest)
    }
    saved[id] = route.merging(["createdAt": String(Date().timeIntervalSince1970)]) { _, new in new }
    UserDefaults.standard.set(saved, forKey: recordsKey)
  }

  private func cancelWatch(_ id: String) {
    lock.lock()
    defer { lock.unlock() }
    watches.removeValue(forKey: id)?.task.cancel()
  }

  private func finishWatch(_ id: String, _ generation: UUID) {
    lock.lock()
    defer { lock.unlock() }
    guard watches[id]?.generation == generation else { return }
    watches.removeValue(forKey: id)
  }

  private func hex(_ bytes: Data) -> String { bytes.map { String(format: "%02x", $0) }.joined() }

  private func watch(_ activity: Activity<OrcaSessionAttributes>) {
    lock.lock()
    defer { lock.unlock() }
    guard !isDestroyed, watches[activity.id] == nil,
      activity.activityState == .active || activity.activityState == .stale else { return }
    let generation = UUID()
    let task = Task { [weak self] in
      defer { self?.finishWatch(activity.id, generation) }
      await withTaskGroup(of: Void.self) { group in
        group.addTask { [weak self] in
          for await token in activity.pushTokenUpdates {
            guard !Task.isCancelled, let self else { return }
            self.sendEvent("onToken", ["activityId": activity.id, "linkId": activity.attributes.linkId,
              "token": self.hex(token), "state": String(describing: activity.activityState)])
          }
        }
        for await state in activity.activityStateUpdates {
          guard !Task.isCancelled, let self else { break }
          self.sendEvent("onState", ["activityId": activity.id, "linkId": activity.attributes.linkId,
            "token": activity.pushToken.map(self.hex) ?? "", "state": String(describing: state)])
          if state == .ended || state == .dismissed { break }
        }
        group.cancelAll()
      }
    }
    watches[activity.id] = ActivityWatch(generation: generation, task: task)
  }
}
